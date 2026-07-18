# Channels — unified inbound/outbound message surfaces

**Status:** P1–P5-HITL IMPLEMENTED (inbound channels replace webhooks/connectors + conversation mapping + outbound delivery + Slack reference channel + HITL over a channel) · rest of P5 (cross-channel hand-off, streamed delivery) DEFERRED — greenfield (pre-release): no back-compat/deprecation constraints, so channels **replace** `webhooks/`/`connectors/` outright rather than layering beside them.
**Wave:** Post-MVP — Interactivity & Integrations
**Depends on:** 01-Q (two-lane execution + `run_jobs` + warm worker), 17 (threads + SSE), 20 (`WebhookVerify` + dispatch — channels **supersede** its `webhooks/`/`connectors/` surfaces), the `input.*` HITL model, 02-S (`DeltaBus` — the transient/durable boundary)
**Unblocks:** first-class Slack/Discord/GitHub/email agents, bidirectional integrations, "approve-from-Slack" HITL, one agent served across many surfaces

---

## Goal

Introduce a **channel**: a per-surface edge adapter that owns *how an agent communicates* with an external platform, in both directions. A channel (1) normalizes an inbound platform event into a run/turn, (2) maps that surface's conversation to a render-agents thread (a resume handle), and (3) delivers the agent's reply back out to the surface it came from.

Today ingress is solid but fragmented, and there is **no first-class egress**. All inbound paths land in the gateway (`POST /workflows/:name`, `POST /threads/:id/messages`, `POST /webhooks/:name`, `POST /connectors/:key`, cron). Outbound is ad-hoc: streaming SSE is *pull* (a client tails the log), and actually *pushing* a reply to Slack/GitHub/email is done inside a model tool or a workflow `ctx.step()` calling that API directly (e.g. the demo's `src/lib/github.ts`). Nothing ties "the reply goes back to the surface that sent the message." Channels close that loop — reusing the event log + job queue as the substrate (additive) while **becoming the single inbound/outbound authoring surface**. Because this is greenfield, they *replace* `webhooks/`/`connectors/` instead of sitting beside them.

This is deliberately modeled on Vercel `eve`'s channel concept (normalize inbound → own a `continuationToken` → decide delivery), adapted to our event-sourced, two-lane substrate.

---

## Why channels (the gap)

- **Inbound already works** and is well-factored: `WebhookAdapter { name, verify?, match, parse }` (`packages/sdk/src/workflow.ts`) and `ConnectorSpec { key, verify?, handle }` (`packages/gateway/src/connector.ts`) both produce a `WebhookMatch { workflow, trigger }` and dispatch. Signature verification is a shared declarative surface (`WebhookVerify`) enforced fail-closed by `checkWebhookAuth` (`packages/gateway/src/verify.ts`), with `github`/`slack`/`stripe`/`standard-webhooks`/`hmac` schemes already implemented.
- **Two inbound concepts, ~90% identical.** `WebhookAdapter` and `ConnectorSpec` differ only in *who authors them* and the route namespace; both are `{ verify, match/handle → WebhookMatch } → dispatch`. Adding a third near-identical concept (channels) would be the real mistake — so channels **absorb** both rather than join them.
- **Outbound has no home.** There is no symmetric "send a message out on this surface" primitive, and no record of *which* external conversation a run belongs to, so nothing can address a reply.
- **Conversation identity is missing.** Threads (`threadId`) model multi-turn memory, but nothing maps an *external* conversation (Slack `channel+thread_ts`, GitHub issue #, email thread) to a `threadId`, so a re-entrant inbound message can't resume the right thread and a reply can't find its target.

Channels **become the one inbound authoring surface** (folding in `webhooks/` + `connectors/`, reusing `WebhookVerify` + dispatch), add the missing conversation mapping, and add durable outbound delivery.

---

## Foundational decisions in play

Referencing the current [Load-Bearing Decisions](../specs/00-foundations.md#load-bearing-decisions):

- **§4 Event log as canonical history.** A channel's inbound is just events (`run.started` + `message.user`); outbound delivery is driven *from* the log (a terminal event) and records its own event. `run_jobs` stays pointers, not state.
- **§3 Two root execution lanes.** Delivery must fire regardless of which lane completed a run — a Lane A workflow root (Render Workflows host) or a Lane B chat turn (warm worker). The design routes delivery through the shared append path so it is lane-agnostic.
- **§5 Composition-root runtime.** Channels are discovered by convention and attached to the one runtime object (`runtime.channels`), exactly like `toolSources` / `workflows`; every service (gateway, worker, workflow host) builds them identically via `loadProject`.
- **§7 Pause/resume by replay + the `input.*` model.** HITL is now a general input request (`kind: "approval" | "message"`). This makes "approve/answer from a channel" a natural later phase: a pending `input.requested` is delivered out; an inbound reply satisfies it via `input.provided`.
- **§9 Transient token deltas.** v1 delivers on **terminal completion only**; token-level "typing" delivery is explicitly out of scope (deltas stay transient over `DeltaBus`, never the delivery path).

**Proposed new decision:** *Channels are the message edge; the agent is comms-agnostic.* An agent/workflow never names a surface; surfaces are added by dropping a `channels/*.ts` file. (Mirrors §1 markdown-first and §2 one-execution-interface.)

---

## Architecture

```
INBOUND                                        OUTBOUND
platform event                                 terminal run event (run.completed)
   │  POST /channels/:id                          │  (any lane: worker / workflow host / inline)
   ▼                                              ▼
gateway channel route                          built-in delivery interceptor  (append pipeline)
 • checkWebhookAuth(channel.verify)             • run bound to a channel? → jobQueue.enqueue
   (reuse WebhookVerify: slack/github/…)          { id:"deliver:<runId>", kind:"deliver" }
 • channel.parse(req) → {conversationId,        │
   input, target}                                ▼
 • resolveConversation(channelId, convId)      chat/delivery worker (Lane B)  run_jobs claim
   → threadId (create/reuse)                    • driveByKind("deliver")  ← BEFORE terminal gate
   ▼                                            • read channel binding + assistant output (log)
 dispatch:                                      • channel.deliver({ conversationId, message })
  • {agent}   → start chat turn (thread)        • emit channel.delivered  (or requeue on throw)
  • {workflow}→ workflow.dispatch(input,trig)      │
   ▼                                              ▼
 run.started { …, channel, externalConversationId }  →  external surface (Slack/GitHub/email)
   │
   └───────────────── shared Postgres event log (run_events) ──────────────────┘
```

Both directions build on the existing spine: inbound is the channel route (superseding `/webhooks` + `/connectors`) reusing `WebhookVerify`; outbound reuses `run_jobs` + the warm worker + the append/interceptor pipeline.

---

## Concepts & contracts

### 1 · The `Channel` type (`@render-agents/sdk`, new `src/channel.ts`)

A channel is the one inbound/outbound adapter — it **replaces** `WebhookAdapter` and `ConnectorSpec`. Same inbound shape (`verify`/`match`/`parse`) + a conversation resolver + an **optional** outbound `deliver`. An inbound-only channel (no `deliver`) is exactly today's webhook (a fire-and-forget workflow trigger); a package-contributed channel is a `channels/*.ts` that calls a factory (e.g. `slackChannel({...})`), replacing the `connectors` export.

```ts
import type { WebhookVerify } from "./webhook-verify.js";
import type { Logger, OAuthTokens } from "@render-agents/sdk";

export interface ChannelInboundEvent {
  /** External conversation id on this surface: Slack `channel:ts`, GitHub issue#, email thread. */
  conversationId: string;
  /** Normalized user message / workflow input. */
  input: unknown;
  /** External author, for attribution + loop-guard. */
  user?: string;
  /** Overrides the channel's default target for this event (else `channel.target`). */
  target?: { agent: string } | { workflow: string; trigger?: string };
}

export interface ChannelDeliverContext {
  conversationId: string;
  /** Assembled reply: flattened assistant text + optional structured result. */
  message: { text: string; data?: unknown };
  env(name: string): string | undefined;
  readonly logger: Logger;
  /** Per-user outbound credential, when the surface needs one (reuses the OAuth store). */
  connection?(provider: string): Promise<OAuthTokens | undefined>;
}

export interface Channel {
  /** Defaults to the file stem (`channels/slack.ts` → "slack"). */
  readonly id: string;
  /** Default routing target for inbound events on this surface. */
  readonly target: { agent: string } | { workflow: string };
  /** Inbound signature policy — enforced by the gateway before parse/dispatch. Reused verbatim from webhooks. */
  readonly verify?: WebhookVerify;
  /** Cheap routing/ack decision from the raw request (Slack URL-verification handshake, event filter). */
  match(req: Request): { ack?: Response } | { event: string } | null;
  /** Normalize a verified request into a turn. */
  parse(req: Request): Promise<ChannelInboundEvent>;
  /** Push a completed reply back to the surface. Throwing requeues (retryable).
   *  OMIT for inbound-only channels — a fire-and-forget workflow trigger, i.e. a former webhook. */
  deliver?(ctx: ChannelDeliverContext): Promise<void>;
}
```

Notes:
- `verify` is the existing `WebhookVerify` — a Slack channel is literally `verify: slackVerify()` (already implemented). No new crypto.
- `match` may short-circuit with an `ack` `Response` for provider handshakes (Slack `url_verification`) without starting a run.
- `deliver` is a plain async fn the author writes (Slack `chat.postMessage`, GitHub `createComment`, SMTP send). It receives only JSON-ish context — no engine internals.
- **Inbound-only stays terse.** A channel with no `deliver` is `{ id, target, verify, match, parse }` — the same authoring weight as the old `WebhookAdapter`. Subsuming must not tax the fire-and-forget case; if it does, the merge regressed DX.

### 2 · Conversation mapping (the missing primitive — eve's `continuationToken`)

Bind an external conversation to a thread so re-entrant messages resume it and replies can be addressed.

- Extend the `run.started` payload (`packages/store/src/events.ts`) with two optional fields, exactly like `threadId`/`userId` were added:
  `{ …, channel?: string; externalConversationId?: string }`.
- Add a `channel_conversations` projection folded from `run.started`: `(channel, externalConversationId) → { threadId, lastRunId }`. Read surface on the store: `resolveConversation(channel, externalId)`.
- Chat-agent channels create/reuse a `threadId` for the mapping (multi-turn memory via thread history); workflow channels may opt in or stay stateless (like today's GitHub demo, which stores state in GitHub labels).

Store work: fold in `Projections` (`packages/store/src/projections.ts`), a `0009_*.sql` table + index, and equivalent memory-store reads — covered by the memory↔pg **parity suite** (`packages/store/tests/pg/parity.test.ts`). Simpler alternative considered: stash the ref in `thread.metadata` (already `Record<string, unknown>`), but that has no reverse index for `(channel, externalId)` lookup, so a projection is preferred.

### 3 · Outbound delivery (the central mechanism)

Durable, retryable, lane-agnostic — as a new job kind, produced from the append path.

- **New job kind** `deliver` (`packages/store/src/job-queue.ts`: `JobKind = "agent" | "resume" | "deliver"`), priority below interactive turns (e.g. 150; cf. `submit.ts` `JOB_PRIORITY`).
- **Producer — post-commit, not an interceptor.** The store's `EventInterceptor` runs **pre-commit** (verified in `MemoryEventLogStore.append`: `intercept` fires before persist/project/publish), so enqueuing there would race the terminal event's own commit. The producer is therefore **post-commit**: a delivery tail loop (on the always-on worker) subscribes to `store.events.tail({})` and, on a terminal event (`run.completed`/`run.failed`) for a **channel-bound** run, enqueues `jobQueue.enqueue({ id: "deliver:<runId>", runId, kind: "deliver", priority: 150 })` — lane-agnostic (all lanes write the shared log; pg `NOTIFY` carries Lane A completions to the worker). In `inline` mode (no worker) delivery runs inline right after the completion via a `deliverForRun(runtime, runId)` helper. The explicit job `id` makes re-enqueue a no-op.
- **Consumer — the warm worker.** Add a `deliver` case to `driveByKind` (`packages/sdk/src/worker.ts`): read the run's channel binding (`run.started.channel` + `externalConversationId`) and assembled reply (last `message.assistant` / `run.result`) from the log, resolve `runtime.channels.get(channelId)`, call `channel.deliver(...)`, emit `channel.delivered`, and `queue.complete`. On throw → `queue.fail({ requeue: true, backoffMs })` (at-least-once via the existing reaper/backoff).
- **Idempotency / effectively-once.** Guard in the worker: skip if a `channel.delivered` event already exists for the run. Combined with the fixed job `id`, delivery is at-least-once → effectively-once.

### 4 · Loader, runtime & gateway wiring

- `loadChannels(root)` (sdk) **replaces** `loadWebhooks` + `loadConnectors`: discover `channels/*.ts`, default-export a `Channel`, key = file stem. Package-contributed surfaces become explicit `channels/*.ts` files importing a factory (e.g. `slackChannel({...})`); the implicit `connectors`-export scan of `tools/*` (`gateway/src/connector.ts`) is deleted.
- `loadProject` (`packages/sdk/src/project.ts`) returns `channels` (in place of `webhooks`); `createRuntime({ channels })` sets `runtime.channels: Map<string, Channel>` (mirrors `toolSources`) so the worker/interceptor can resolve `deliver`.
- Gateway: `GatewayOptions.channels` (replaces `webhooks`/`connectors`); a `channels` route (`packages/gateway/src/routes/channels.ts`, replacing `routes/webhooks.ts`) mounts `POST /channels/:id`, calls `checkWebhookAuth(channel.verify, …)` then `match`/`parse`, resolves the conversation, and dispatches (workflow → `workflow.dispatch`; agent → the existing thread-turn path via `startAgentRun`). Export from `packages/gateway/src/index.ts`.
- Credentials: inbound = `WebhookVerify` (env-named secrets, unchanged); outbound = the OAuth store via `ctx.connection(provider)` for per-user, or env for app-level bot tokens (like the demo's `GITHUB_TOKEN`). No managed-Connect equivalent (that's Vercel-specific).

---

## Relationship to existing primitives

- **Webhooks / connectors → removed (subsumed).** Greenfield, so there's no reason to carry two near-identical inbound concepts *plus* channels. `channels/` is the single inbound authoring surface: an inbound-only channel (no `deliver`) *is* a webhook; a package-factory channel *is* a connector. The reusable, hard part — `WebhookVerify` + `checkWebhookAuth` — **stays**; `WebhookAdapter`, `ConnectorSpec`, `loadWebhooks`, `loadConnectors`, the `connectors` scan, and the `/webhooks`+`/connectors` routes are **deleted**.
- **Net taxonomy: two inbound surfaces**, down from four — (a) the built-in HTTP/chat API (`/workflows`, `/threads`, cron) and (b) channels. We deliberately do **not** collapse the HTTP/chat API into a channel (eve models it as its implicit `eve.ts` default channel); it's our stable core contract, not a pluggable adapter.
- **Threads:** a channel conversation *is* a thread; channels add the external binding + push delivery on top of the existing thread transcript + SSE.

---

## Scope

**In:**
- `Channel` contract + `loadChannels` + `runtime.channels` + `loadProject`/`createRuntime` wiring.
- **Remove `webhooks/` + `connectors/`:** delete `WebhookAdapter`/`ConnectorSpec`/`loadWebhooks`/`loadConnectors`/the `connectors` scan and the `/webhooks`+`/connectors` routes; keep `WebhookVerify`. (Greenfield — no shims/aliases.)
- Gateway `POST /channels/:id` inbound route reusing `checkWebhookAuth`/`WebhookVerify` (replaces the webhook/connector routes).
- `channel` + `externalConversationId` on `run.started`; `channel_conversations` projection + `resolveConversation` (memory + pg + parity).
- `deliver` job kind; built-in delivery interceptor (producer); worker `deliver` consumer; `channel.delivered` (+ `channel.delivery_failed`) events.
- Convert the demo's GitHub webhook(s) (`issue-to-pr`, `pr-review`) to `channels/github.ts` (inbound trigger + outbound review/comment through one module); update the scaffolder `blueprint.ts` to emit `channels/` instead of `webhooks/`.

**Out (deferred):**
- **Streamed/partial delivery** (typing indicators, token streaming to the surface) — terminal-only in v1; deltas stay transient (§9).
- **Cross-channel hand-off** (eve's `receive` — one channel routing to another).
- **HITL over a channel** (approve/answer from a surface) — ✅ delivered in P5 (deliver `input.requested` out; an inbound message satisfies `input.provided`).
- **Managed-credential layer** (Vercel-Connect analog) — reuse OAuth/env.
- **Rich formatting adapters** (Slack Block Kit, Adaptive Cards) beyond a text/`data` mapping.

---

## Schema

- `run_jobs.kind` gains `'deliver'` (`packages/store/sql/0007_run_jobs.sql` CHECK/comment; no structural change). `JobKind` union updated.
- New migration `0009_channels.sql`:
  ```sql
  CREATE TABLE IF NOT EXISTS channel_conversations (
      channel                  TEXT NOT NULL,
      external_conversation_id TEXT NOT NULL,
      thread_id                TEXT,
      last_run_id              TEXT REFERENCES runs(id),
      created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (channel, external_conversation_id)
  );
  ```
- `run.started` payload gains optional `channel` / `externalConversationId` (event-vocabulary change; folds into `runs` + the new projection).
- New `channel.delivered` / `channel.delivery_failed` events. **Decision:** categorize under the existing `"lifecycle"` category to avoid a new `EventCategory` (lower surface), or add a `"channel"` category for clarity — lean lifecycle for v1.

---

## Phasing

- **P1 — inbound channels (replace webhooks/connectors). ✅ Done.** `Channel` type + `loadChannels` + `loadProject.channels` + gateway `POST /channels/:id` (reusing `checkWebhookAuth`/`WebhookVerify`), dispatching workflow-target channels. **Deleted** `webhooks/` + `connectors/` (types, loaders, routes, the `connectors` scan, and the `/webhooks`+`/connectors` routes); converted the demo GitHub webhook + the scaffolder to `channels/`. All packages build and tests are green. Deferred within P1: agent-target channels return `501` (need the P2 conversation mapping) and `runtime.channels` lands with P3's delivery worker.
- **P2 — conversation mapping. ✅ Done.** `channel`/`externalConversationId` on `run.started` (folded onto `RunRecord` for P3's delivery) + a `channel_conversations` projection with `resolveConversation` (memory + Postgres via `0009_channels.sql`, wired into the migration ledger + parity suite). Agent-target channels now resolve/reuse a thread per `(channel, externalConversationId)` — the 501 is gone — so a re-entrant inbound message continues the same conversation (multi-turn memory via the thread transcript); workflow-target channels stamp the same binding. Store + gateway tests green.
- **P3 — outbound delivery. ✅ Done.** `deliver` `JobKind` + `channel.delivered` event (store); `runtime.channels` (populated by `loadProject`); `deliverForRun` assembles the reply (last assistant message, else the run result) and pushes it via `channel.deliver`, then records `channel.delivered` (the idempotency guard → effectively-once). **Producer:** a post-commit tail loop in `runWorker` enqueues a `deliver` job for any terminal channel-bound run (lane-agnostic — every run completes to the shared log); the worker's processor drains it **before** the terminal gate. **Inline mode:** the channel route delivers synchronously after the run completes. SDK + gateway tests green (`deliverForRun` unit, worker queue producer→consumer, gateway inline delivery). The demo GitHub channel stays inbound-only (its workflows own their GitHub side effects); `deliver` is exercised for agent-target channels.
- **P4 — reference platform channel. ✅ Done.** `slackChannel({...})` (`packages/sdk/src/channels/slack.ts`) — the built-in Slack adapter, authored entirely on the `Channel` contract (no engine internals), exported from `@render-agents/sdk`. **Inbound:** `verify: slackVerify()` (gateway checks the `v0=` HMAC over the raw body); `match` answers the one-time `url_verification` handshake, filters to events we act on (`app_mention`, threaded `message` replies, DMs), **loop-guards** our own/any bot's posts + message subtypes, and de-dupes Slack's at-least-once retries. `parse` normalizes to `{ conversationId, input, user }`, keying the conversation on `channel:thread_ts` (channels) or the DM id (DMs) and stripping the leading `<@bot>` mention. **Outbound:** `deliver` posts the reply with `chat.postMessage` (threaded under the originating message, or flat for DMs) using a bot token from env. **Contract change (load-bearing):** `Channel.match` may now return a `Promise` (`ChannelMatch | Promise<ChannelMatch>`) — Slack routes on the request *body*, not headers — and the gateway route `await`s it; all existing sync channels are unaffected. Demo `channels/slack.ts` targets the interactive `assistant` (which gates `deploy` on approval, so a "deploy" ask exercises P5 HITL-to-Slack). SDK unit tests (match/parse/deliver: handshake, loop-guard, retry-dedupe, DM vs thread keying, mention-strip, threaded/flat delivery, error→requeue) + gateway signed e2e (verify→turn→threaded delivery, handshake, bad-signature 401) green. Deferred: rich formatting (Block Kit) — the minimal text mapping stands.
- **P5 — advanced.**
  - **HITL over a channel. ✅ Done.** A channel-bound run that pauses now delivers its pending `input.requested` *out* to the surface (the `deliverForRun` producer fires on `run.paused` too) — `ChannelDeliverContext.input` carries the request so a channel can render an approval/question; `channel.delivered` gains `inputRequestId` for per-input idempotency (prompt-on-pause and reply-on-completion are distinct deliveries). Inbound, an agent-target channel message **satisfies** a pending `message`-input on the conversation's active run (`input.provided` + resume) instead of starting a new turn; approval gates still route to the inputs API (`409`). **Queue fix (load-bearing):** `deliver` jobs are now exempt from the one-active-job-per-run index (`0010_deliver_jobs.sql`) and idempotent by explicit id, so a delivery coexists with the run's still-active turn job — without this the producer's enqueue was silently dropped on `run.paused` (the turn job is always still active there) and raced on `run.completed`. SDK + store + gateway tests green (prompt-delivery unit, deliver/turn coexistence parity, gateway HITL round-trip).
  - **Cross-channel hand-off. ⏸️ Deferred (low value).** eve's `receive` (one channel routing inbound to another) is niche here; a workflow/agent can already fan out to another surface via that surface's `deliver`. Revisit on concrete need.
  - **Streamed/partial delivery. ⏸️ Deferred (conflicts with D13).** Pushing token deltas to a surface fights the transient-delta boundary (deltas aren't persisted), and most chat platforms want a final message + a typing indicator, not per-token edits. Terminal/pause delivery stays the model; a lightweight "typing" ping is a possible small future add.

---

## Exit criteria / acceptance

- A `channels/slack.ts` (or `github.ts`) is auto-discovered; `POST /channels/:id` verifies the signature (reusing `WebhookVerify`, fail-closed in prod), and an unverified request is `401` before any dispatch.
- An inbound message resolves to a thread via `(channel, externalConversationId)`; a second message on the same external conversation resumes the same `threadId` (multi-turn memory), proven over the memory store and Postgres (parity).
- When the run completes — in **either** lane (warm worker or Render Workflows host) or inline — the reply is delivered exactly once to the originating surface; a delivery failure requeues with backoff and eventually dead-letters, visible via `GET /admin/jobs`; a `channel.delivered` event is in the log/span tree.
- Killing the worker mid-delivery leaves the `deliver` job reclaimable; a redelivery does not double-post (idempotency guard).
- With no `DATABASE_URL` (`inline`), a channel works end-to-end in one process (in-memory queue + interceptor), matching production behavior.
- `webhooks/` and `connectors/` no longer exist: a fire-and-forget workflow trigger is a `channels/*.ts` with no `deliver`, and a former connector is a channel file calling a package factory — each authored as tersely as before. No `/webhooks` or `/connectors` route remains.

---

## Risks / open questions

- **Worker terminal-gate swallows deliver jobs.** `buildJobProcessor` (`packages/sdk/src/worker.ts`) completes any claimed job whose run is already terminal (the D3 "no blind re-run" guard). A `deliver` job runs *because* the run is terminal — so `driveByKind` must handle `deliver` **before** the terminal gate, or the gate must be kind-aware. Must-fix in P3.
- **`JobQueue.enqueue` idempotency is per-run, not per-kind.** "If the run already has an active job, return it" (`job-queue.ts`) means a `deliver` job can't be enqueued while the run's `agent` job is still active. Delivery is enqueued on the *terminal* event (agent job already `done`), so this is fine — but the invariant must hold, and enqueue-by-explicit-`id` is the safety net. Alternatively make idempotency `(runId, kind)`.
- **Delivery producer (resolved: post-commit).** The store interceptor is pre-commit (confirmed in `MemoryEventLogStore.append`), so the producer is a post-commit delivery tail loop on the worker (+ an inline path), **not** an append-pipeline interceptor — see §3. Gate the tail loop behind "channels configured" so there's zero cost when unused.
- **Inbound-only ergonomics (the subsume risk).** Merging must not make a plain trigger heavier: an inbound-only channel (`{ id, target, verify, match, parse }`, no `deliver`) must author as tersely as the old `WebhookAdapter`, and the package-factory path must stay one line. If either grows, the subsume regressed DX — treat as an acceptance gate, not just a hope.
- **Event-vocabulary surface.** Adding `channel.*` events + `run.started` fields touches `events.ts`, `projections.ts`, both stores, and the parity suite. Keep it minimal (lifecycle category; one delivered/failed pair) to bound the blast radius.
- **Conversation identity for non-thread workflow channels.** Threads fit chat; a stateless workflow channel (e.g. PR review) may not want a thread. Decide whether the mapping is thread-only or also keyed to a run series.
- **Loop guard.** A channel must ignore its own outbound (a bot replying to itself) — reuse the demo's `GITHUB_BOT_LOGIN` idea generically (channel `parse` drops sender == bot).
- **Ordering / at-least-once.** Delivery is at-least-once; the idempotency guard makes it effectively-once, but out-of-order multi-turn delivery on very chatty surfaces needs thought (per-conversation serialization) — defer past v1.
- **Foundations anchors.** Sibling docs (`01-queue.md`, `02-streaming.md`) link stale `#d10`-style anchors; foundations is now a numbered list. This doc references by name — worth a follow-up pass to fix the old links repo-wide.

---

## Appendix: mapping to Vercel `eve` (research)

| eve concept | render-agents before | this plan |
|---|---|---|
| Channel file `agent/channels/*` | `webhooks/` + `connectors/` (two inbound-only concepts) | `channels/*.ts` (`Channel`) — one surface, inbound + outbound |
| Normalize inbound | `WebhookAdapter.parse` / `ConnectorSpec.handle` | `Channel.parse → ChannelInboundEvent` (same shape) |
| `continuationToken` | — (threads created by API) | `channel_conversations`: `(channel, externalId) → threadId` |
| `send()` / delivery | ad-hoc tool or `ctx.step()` | `Channel.deliver` + `deliver` job (durable) |
| Signature verification | `WebhookVerify` (github/**slack**/stripe/std) | reused verbatim (the one piece that survives the merge) |
| Default HTTP channel (`eve.ts`) | gateway `/threads` + SSE (implicit) | unchanged; the built-in surface stays, channels cover external platforms |
| Vercel Connect (managed auth) | OAuth store / env | reused; no managed-Connect analog |

What this plan leans on that already landed (verified against the current tree): the declarative `WebhookVerify` surface + `checkWebhookAuth` (Sprint 20 follow-up), the `input.*` HITL generalization, `run_jobs` + warm worker + reaper (01-Q), the append-pipeline interceptor seam (hooks), and `loadProject`/`runtime` composition.
