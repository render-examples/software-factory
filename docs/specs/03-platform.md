# Platform

**Status:** IMPLEMENTED (living)
**Date:** 2026-07-02
**Layer:** L3 - persistence and serving layer.

This layer describes the durable substrate (store + gateway) as currently implemented.

---

## Store Model

The platform is event-first:

- canonical log: `run_events`,
- read models: maintained projections (`runs`, `spans`, `run_messages`, `messages`, `tool_calls`, `workflow_steps`, `input_requests`),
- operational tables: `threads`, `oauth_connections`, `schedules`, `run_jobs`.

Event append path:

1. validate/rewrite/veto through optional event interceptor,
2. append event with per-run sequence,
3. apply projection fold,
4. publish to live tail (`tail` subscribers).

`text.delta` is transient and rejected from durable append.

---

## Postgres Migrations

`packages/store/sql` migrations currently define:

1. `threads`
2. `runs`
3. `run_events` (+ `next_event_seq`)
4. projection tables + `schedules`
5. `messages` + `oauth_connections`
6. schedule FK adjustment
7. `run_jobs`
8. `runs.parent_span_id`
9. `channel_conversations` (+ `runs.channel`/`external_conversation_id`)
10. `run_jobs` deliver-kind index (delivery jobs coexist with the turn job)
11. `schedules.user_id` (tenant-scope schedules)

The same schema contracts are mirrored in memory store implementations for tests/dev.

---

## Queue and Delta Channels

### `run_jobs` (durable control queue)

- kinds: `agent`, `resume`,
- statuses: `queued`, `running`, `done`, `failed`, `dead`,
- one active job per run enforced in storage,
- consumed by warm worker in queue mode.

### `DeltaBus` (transient token stream)

- carries token deltas live (`runId`, optional `threadId`, `seq`, `text`),
- backed by memory or Postgres notify channel,
- not persisted, replayed, or retained.

---

## Thread Model

Threads are durable conversation containers:

- thread ownership comes from auth principal (`userId`),
- each user message creates a new run in that thread (when using `defaultAgent` path),
- single active run per thread is enforced,
- transcript is read from `messages` projection (across runs in a thread).

Busy behavior:

- running/pending turn -> `409 thread busy`,
- paused with pending approval-kind input -> `409` until that input is provided,
- paused with pending message-kind input -> message is accepted and resumes paused run.

---

## Input Requests

HITL input state is event-sourced:

- request: `input.requested`,
- resolve: `input.provided`,
- auto path: `input.auto`.

Gateway list route (`GET /inputs`) reads from input projection with optional status/kind/thread filtering.

Resolution writes events and triggers replay-driven resume.

---

## Multi-Tenancy and Auth

Every request resolves to a `Principal { userId, role: "operator" | "user" }`.
`userId` is the tenant boundary and is ALWAYS derived from auth, never a
client-supplied param. Ownership is enforced two ways: by-id reads/mutations call
`canAccess(ownerUserId, principal)` (operators see everything; users only their
own records — a foreign id returns `404`, not enumerable), and list routes filter
by `principal.userId`. Store records carry the owner: `runs.userId`,
`threads.userId`, `schedules.userId`, `oauth_connections.userId`.

Identity is a pluggable `AuthResolver` (`createGatewayApp({ auth })`); the default
maps a shared `RENDER_FACTORY_API_KEY` bearer to a single **operator**. Built-ins:

- `jwtAuthResolver({ issuer, audience, jwksUri, userIdClaim?, roleFrom? })` —
  verifies a bearer JWT against an IdP JWKS (jose; issuer/audience/expiry/signature
  checked), maps a claim (default `sub`) to `userId`, returns `role: "user"` by
  default. This is the per-user multi-tenancy default. Fail-closed on any error.
- `composeResolvers(...)` — first non-null wins, e.g. per-user JWT plus a
  shared-key operator break-glass.
- `bearerKeyResolver` (shared key → operator) and the UI cookie session.

Control plane is operator-only: a `requireOperator()` middleware gates all
`/admin/*` routes (`403` for `role: "user"`), so end users can never drive global
maintenance (retention, run reaper, queue depth, schedule tick).

Per-user SSE: EventSource can't send an `Authorization` header, so a client
authenticates normally then calls `POST /auth/stream-token` for a short-lived
signed token bound to its principal, and opens `EventSource(...?token=...)`. The
`?key=` query fallback remains operator-only; the scoped stream handlers still
enforce `canAccess`.

OAuth connections are per `(userId, provider)` and encrypted at rest:

- authorize/callback/revoke routes live in gateway,
- user identity comes from request principal (not query/body userId),
- refresh path is single-flight in store (lock + refresh callback).

When no OAuth providers are configured, OAuth routes and `/connections` are not mounted.

---

## Channels

Channels are the single inbound message surface (they replace the former
webhooks + connectors). Each channel is discovered from `channels/*.ts` (the
filename is the channel id) and mounted at:

- `/channels/:id`

Channel routes are **public** (outside the operator API-key middleware, via the
`isPublicPath` carve-out) — the inbound signature is the authentication. The
gateway enforces each channel's declarative `verify` policy here:

- the raw body is read once, then verification runs **before** `match`/`parse`
  and dispatch — constant-time signature comparison over the raw bytes, plus a
  replay window for timestamped schemes,
- a failed or missing-secret verification returns `401` and never dispatches,
- a **missing** `verify` is fail-closed: rejected in production, warn-allowed in
  dev (`webhookVerifyRequired`, env `RENDER_FACTORY_REQUIRE_WEBHOOK_VERIFY`),
- `verify: "none"` is an explicit opt-out.

A channel targets a **workflow** (dispatch a run) or an **agent** (resolve/create
the thread bound to `(channel, conversationId)` and drive a turn — the binding is
folded into `channel_conversations` so a re-entrant message resumes the same
conversation). Built-in schemes are `github`, `slack`, `stripe`,
`standard-webhooks`, and generic `hmac` (`packages/gateway/src/verify.ts`; config
helpers in `@render-factory/sdk`).

---

## Schedules

Runtime-managed schedules are CRUD records in `schedules` table, owned by the
creating tenant (`schedules.userId`, stamped from auth): CRUD is scoped via
`canAccess` / a `userId` list filter, exactly like runs and threads.

Reconcile model:

- `POST /admin/schedules/tick` (operator-only, per-minute Render Cron) checks due entries,
- dispatches matching workflows with trigger `"cron"`, stamping the schedule's
  `userId` on the fired run so cron runs are tenant-scoped,
- updates `lastRunId` and `lastRunAt`,
- dedupes by minute and restores marker on dispatch failure for retryability.

---

## Gateway API Surface

Primary route groups are implemented in `packages/gateway/src/routes`:

- runs: list/detail/events/spans/tool calls/cancel/workflow dispatch,
- streams: run/thread/global SSE,
- threads: create/list/detail/message delivery,
- HITL: `/inputs`, `/inputs/:id/provide`, and `/runs/:id/input`,
- OAuth: authorize/callback/revoke,
- schedules: CRUD + tick endpoint,
- channels: `POST /channels/:id`,
- auth: `/whoami`, `POST /auth/stream-token` (per-user SSE credential),
- admin (operator-only): `/admin/retention`, `/admin/runs/reap`, `/admin/jobs`, `/admin/schedules/tick`,
- UI shell serving (`/ui`).

Auth and ownership are enforced in middleware + route-level ownership checks.

---

## SSE Semantics

### Run stream (`/runs/:id/stream`)

- catch-up from sequence cursor,
- tails durable events plus transient deltas,
- closes on terminal run events.

### Thread stream (`/threads/:id/stream`)

- ownership-scoped: a non-operator must own the thread's metadata row (a thread
  known only via the event log has no owner, so users are denied — no bypass),
- catch-up replay across all thread runs,
- composite cursor id (`runId:seq`),
- tails durable events + transient deltas.

### Global stream (`/events/stream`)

- operator-only, durable events only,
- forward-only live tail (no historical replay),
- composite cursor id (`runId:seq`).

---

## Observability and Cost

Span trees are projection output from events.

- root spans are `workflow` or `agent` based on `run.started.spanKind`,
- tool/llm/step spans are derived from corresponding event pairs,
- run `totalCostUsd` is per-run fold,
- all-in aggregate across descendant runs is computed at read time (`aggregateRunCost`).

