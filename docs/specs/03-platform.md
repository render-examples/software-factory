# Platform

**Status:** DRAFT
**Date:** 2026-06-25

**Layer:** L3 — *what persists & serves.* Part of the [render-agents specification](00-foundations.md) ([Document Map](00-foundations.md#document-map)).

This layer covers the durable substrate beneath the runtime: the Postgres schema, the stores for threads, approvals, OAuth, webhooks, connectors, and schedules, the web gateway, and the observability model. Runtime behavior that drives these stores lives in [Execution](02-execution.md); exact type shapes live in the [Type Reference](05-type-reference.md).

Each section follows the same shape: **Purpose** (what & why), **Model** (how it works), **Contract** (link to exact types), and an **Example** where useful.

---

## Store & Postgres schema

**Purpose** — The append-only event log is the single source of truth. `run_events` is the canonical store; `runs`, `spans`, `run_messages`, `messages`, `tool_calls`, `workflow_steps`, and `approval_requests` are **maintained projections** folded from it on append — kept as tables (not views) so existing indexes and query patterns stay fast. Threads, OAuth, schedules, and the chat-lane `run_jobs` queue are independent operational tables.

**Model** — Writes go through `RunStore.events.append`, which (atomically) inserts the event, updates the affected projections, and `NOTIFY`s the stream. `append` also runs a pre-commit **`EventInterceptor`** seam — an optional `(event, meta) → continue | rewrite | reject` hook (how the engine adapts user `hooks/` onto the single write path) — so an observe/transform/veto applies uniformly to what gets persisted, projected, and streamed. Migrations are applied by `RunStore.init()` under a Postgres advisory lock, as **eight ordered SQL files** run in sequence (`packages/store/sql/`, `applyMigrations`) so all foreign keys resolve:

1. `0001_threads.sql` — `threads` (no FKs — the top-level operational record)
2. `0002_runs.sql` — `runs` (FK → `threads`) + the one-active-run-per-thread partial unique index
3. `0003_run_events.sql` — `run_events` (FK → `runs`), the canonical log, plus the `next_event_seq()` allocator function
4. `0004_projections.sql` — `spans`, `tool_calls`, `run_messages`, `workflow_steps`, `approval_requests`, and `schedules` (FK → `runs`) — projections + the schedule store
5. `0005_messages_oauth.sql` — `messages` (FK → `threads`; `run_id` is a non-FK provenance column) + `oauth_connections` (no FKs)
6. `0006_schedules_fk.sql` — relaxes `schedules.last_run_id` FK to `ON DELETE SET NULL` (an `ALTER`, not part of the initial `CREATE`)
7. `0007_run_jobs.sql` — `run_jobs` (FK → `runs` `ON DELETE CASCADE`), the chat-lane queue
8. `0008_run_parent_span.sql` — adds `runs.parent_span_id` + its partial index (cross-run trace stitching)

The blocks below document each table for reference and **follow the same application order** (creating `runs` before `threads` would violate the FK). Each migration is idempotent — every `CREATE TABLE` uses `IF NOT EXISTS`, the function uses `CREATE OR REPLACE`, and the `ALTER` in `0006` is drop-if-exists-then-add — so re-running the full sequence on every boot is a safe no-op. **Event payloads are versioned and immutable** — history is never rewritten; schema changes add new event versions.

**`run_events`** (canonical) — the append-only log; every run fact is an event here. All tables below are derived from it.

```sql
CREATE TABLE run_events (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  seq         BIGINT NOT NULL,          -- gap-free total order within the run
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  category    TEXT NOT NULL,            -- lifecycle | message | tool | step | model | approval | delegation | context
  type        TEXT NOT NULL,           -- e.g. tool.result, llm.call, run.paused
  agent_name  TEXT,
  span_id     TEXT,                     -- set on span-producing events
  parent_span_id TEXT,
  payload     JSONB NOT NULL,           -- the RunEvent
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX idx_run_events_seq ON run_events(run_id, seq);
CREATE INDEX idx_run_events_run ON run_events(run_id, id);
CREATE INDEX idx_run_events_type ON run_events(run_id, type);
```

**Gap-free `seq` allocation.** `0003_run_events.sql` also defines a `next_event_seq(p_run_id)` plpgsql function, called *inside* the append transaction. It takes a **transaction-scoped advisory lock** keyed on the run id (`pg_advisory_xact_lock`) and then returns `MAX(seq)+1` for that run. The lock genuinely serializes concurrent writers on the same run — `MAX(seq)+1` alone races under `READ COMMITTED` — and auto-releases at `COMMIT`/`ROLLBACK`; the unique index on `(run_id, seq)` remains a correctness backstop.

**Projections vs. log-only events.** Not every event type has a projection. Events fold into the tables below (`run.*` → `runs`/`spans`, `message.*`/`tool.*` → `run_messages`/`messages`/`tool_calls`/`spans`, `step.*` → `workflow_steps`/`spans`, `llm.call` → `spans` + `runs.total_cost_usd`, `approval.requested`/`approval.resolved` → `approval_requests`). The remaining event types — `approval.auto`, `subagent.spawned`, and `context.compacted` — are **log-only**: persisted to `run_events` (and streamed over SSE) for audit and UI, but *not* folded into any projection table. In particular, the subagent hierarchy is **not** reconstructed from `subagent.spawned` into a projection; it is recovered at read time from `runs.parent_span_id` via `listChildRuns` (see [Observability](#observability)).

**`runs`** (projection) — summary row per workflow run or agent invocation; status = latest lifecycle event, `total_cost_usd` folds `llm.call` events. Maintained on append and often retained on a longer horizon than event-detail tables for low-cost operational history. `parent_span_id` is a **read projection for cross-run trace stitching**: a run spawned by another run (workflow `.task()`/`.run()` fan-out or an LLM subagent) records the parent span it hangs off, folded from the `run.started` event's `parent_span_id`; top-level roots are `NULL`. It is added by migration `0008` (see below), indexed for child lookups, and surfaced on [`RunRecord.parentSpanId`](05-type-reference.md#runrecord) so the operator UI can hide child runs from the top-level list and stitch them into the parent's trace.

```sql
CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  workflow        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  input           JSONB,
  result          JSONB,
  error           TEXT,
  trigger         TEXT,
  total_cost_usd  NUMERIC NOT NULL DEFAULT 0,
  thread_id       TEXT REFERENCES threads(id),
  user_id         TEXT,
  agent_version   TEXT,
  parent_span_id  TEXT,                     -- cross-run parent (folded from run.started); NULL for roots. Added in 0008.
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX idx_runs_workflow ON runs(workflow);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_thread ON runs(thread_id);
CREATE INDEX idx_runs_user ON runs(user_id);
-- Child lookup: runs hanging off a given set of parent spans (added in 0008).
CREATE INDEX idx_runs_parent_span ON runs(parent_span_id) WHERE parent_span_id IS NOT NULL;
```

**`spans`** (projection) — the observability tree, folded from span-producing events (`*.started`/`*.completed`). `status` is one of `running` | `ok` | `error`: a span opens `running` on its start event and closes to `ok` (with `output`) or `error` (with `error`) on completion — `run.completed`/`step.completed`/a successful `tool.result` → `ok`; `run.failed`/`run.cancelled`/an error `tool.result` → `error`.

```sql
CREATE TABLE spans (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  parent_id   TEXT,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',  -- running | ok | error
  input       JSONB,
  output      JSONB,
  error       TEXT,
  attributes  JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX idx_spans_run_id ON spans(run_id);
```

**`tool_calls`** (projection) — folded from `tool.called`/`tool.result` events for fast idempotency lookups. `RunContext.appliedToolResult` reads it before dispatching a tool; if a result exists, it short-circuits. (The events are canonical; this table is the index over them.) The row's `id` is the **provider `toolCallId`**, and `idempotency_key = idempotencyKey(runId, toolCallId)` — a `SHA-256` of the run id and tool-call id (`packages/store/src/idempotency.ts`) — enforced unique per run. `status` moves through `pending` (default) → `running` (set on `tool.called`) → `completed` | `failed` (set on `tool.result`, `failed` when the result is an error). The idempotency read only matches rows in a terminal `completed`/`failed` state.

```sql
CREATE TABLE tool_calls (
  id              TEXT PRIMARY KEY,          -- the provider toolCallId
  run_id          TEXT NOT NULL REFERENCES runs(id),
  idempotency_key TEXT NOT NULL,             -- SHA-256(runId, toolCallId)
  tool_name       TEXT NOT NULL,
  input           JSONB,
  result_content  TEXT,
  result_is_error BOOLEAN DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_tool_calls_idempotency ON tool_calls(run_id, idempotency_key);
CREATE INDEX idx_tool_calls_run_id ON tool_calls(run_id);
```

**`run_messages`** (projection) — the LLM message history per agent invocation, folded from `message.*`/`tool.*` events. Answers "what did the model see, what can be resumed?" `RunStore.getMessages` reads it; on resume the runner reconstructs the loop position from here (non-idempotent tool calls are not re-executed). Canonical content lives in `run_events`.

```sql
CREATE TABLE run_messages (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  agent_name  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_messages_run_agent ON run_messages(run_id, agent_name, seq);
```

**`threads`** — the top-level operational record: a durable line of work owned by a `user_id` (from auth), each served by a *sequence* of runs over time. The partial unique index enforces at most one active run per thread, so a new turn cannot start (or a stale revived run cannot race) while one is in flight. The active run is **derivable** from that index — the one run in `pending`/`running`/`paused` for the thread — rather than a stored `threads` column, so it can't drift from the runs table.

The [`Thread`](05-type-reference.md#thread) domain object deliberately carries **no** `currentRunId` field: "which run is active" is a projection, not thread state, so clients derive it via `GET /runs?threadId=<id>` (roots-only) and pick the one non-terminal run. This keeps the data model free of a UI-shaped pointer that could drift from the `runs` table.

```sql
CREATE TABLE threads (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  metadata    JSONB,
  status      TEXT NOT NULL DEFAULT 'active',
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_threads_user ON threads(user_id);

-- At most one active (pending/running/paused) run per thread.
-- A thread spans many runs over time, but only one is live at once.
CREATE UNIQUE INDEX idx_runs_thread_active
  ON runs(thread_id)
  WHERE status IN ('pending', 'running', 'paused');
```

**`messages`** — user/assistant thread turns: the **human-facing, agent-agnostic transcript** (distinct from the model-facing, per-agent `run_messages`). A **projection folded from `message.user`/`message.assistant` events** (not independently authored — D10). Its primary key is the **source event coordinate `(run_id, seq)`** so the fold is an idempotent upsert and the table rebuilds byte-identically on replay; it is scoped by `thread_id` so a thread's turns span its runs. Unlike the high-volume event-detail projections (`spans`/`tool_calls`/…), this transcript is **retained with the thread** (user data), not trimmed at the event-detail horizon — see [Operations → Retention](04-operations.md#retention).

```sql
CREATE TABLE messages (
  run_id      TEXT NOT NULL,   -- provenance (the run/log this turn folded from); NOT FK-enforced:
                               -- the transcript outlives run summaries + the event horizon
  seq         BIGINT NOT NULL,
  thread_id   TEXT NOT NULL REFERENCES threads(id),
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX idx_messages_thread ON messages(thread_id);
```

`run_id` is a deliberate **non-FK provenance column**: `messages` is retained with the thread (user data), but `runs`/`run_events` are trimmed at their retention horizons, so a hard FK would break on trim. The transcript therefore survives even after its source run's detail is gone.

**`approval_requests`** (projection) — pending and resolved HITL approvals, folded from `approval.requested`/`approval.resolved` events.

```sql
CREATE TABLE approval_requests (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  tool_name    TEXT NOT NULL,
  tool_input   JSONB,
  agent_name   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT,
  reason       TEXT
);

CREATE INDEX idx_approvals_run_id ON approval_requests(run_id);
CREATE INDEX idx_approvals_status ON approval_requests(status);
```

**`oauth_connections`** — per-user OAuth tokens (encrypted at rest).

```sql
CREATE TABLE oauth_connections (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);
```

**`schedules`** — runtime-managed scheduled triggers. The table is created in `0004`; migration `0006` then relaxes the `last_run_id` FK to `ON DELETE SET NULL` (it is *not* on the initial `CREATE`) so retention can trim the run a schedule last fired while the schedule survives (its `last_run_id` simply clears), consistent with "schedules never auto-expire".

```sql
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  workflow        TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  input           JSONB,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_run_id     TEXT REFERENCES runs(id),  -- FK relaxed to ON DELETE SET NULL by migration 0006
  last_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**`workflow_steps`** (projection) — memoized `ctx.step(name, fn)` results, folded from `step.completed` events. The runtime checks `(run_id, name)` before running a step and short-circuits on a hit. This is what makes handler re-execution (HITL resume / retry) safe for side-effecting steps (see [Execution → Determinism & replay](02-execution.md#determinism--replay)).

```sql
CREATE TABLE workflow_steps (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  name       TEXT NOT NULL,
  result     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, name)
);
```

**`run_jobs`** — the **chat-lane (Lane B) durable queue** (operational, not a projection). A job is a **pointer, not state**: the run's identity/input/trigger already live in the `run.started` event (D10); a row only references the run plus what to do with it (`kind`). The warm worker claims jobs via `SELECT … FOR UPDATE SKIP LOCKED` and drives them in-process (see [Threads](#threads) and [D12](00-foundations.md#d12--two-execution-lanes-durable-workflows-vs-interactive-chat)). Only the chat lane uses this — durable **workflows are queued by Render**, so there is no `workflow` kind. `kind` is `'agent'` (one chat turn) or `'resume'` (re-drive a turn paused for within-turn HITL); `priority` orders claims (lower first — `resume` preempts fresh `agent` turns to unblock waiting humans). `ON DELETE CASCADE` lets retention drop a run's jobs with it.

> **Known gap (reconciliation):** the `run_jobs` table and enqueue path (`submitRootRun`) ship, but the standalone chat worker that claims jobs is out of scope here. In the gateway's **inline execution mode** (local dev / tests) each turn is driven in-process at enqueue time via `driveInline`; the durable queue-worker (Lane B) is the production path — see `packages/sdk/src/dispatch.ts`.

```sql
CREATE TABLE run_jobs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                  -- 'agent' | 'resume' (chat lane only)
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed | dead
  priority      INT  NOT NULL DEFAULT 100,      -- lower runs sooner (resume < agent)
  payload       JSONB,                          -- target name, plan, identity (forward-flex)
  attempts      INT  NOT NULL DEFAULT 0,        -- claim count (delivery/crash-loop budget)
  max_attempts  INT  NOT NULL DEFAULT 5,        -- delivery budget; D3 logic-retry is the runner's job
  available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at     TIMESTAMPTZ,
  locked_by     TEXT,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_run_jobs_claim ON run_jobs(status, priority, available_at);
CREATE INDEX idx_run_jobs_locked ON run_jobs(locked_at) WHERE status = 'running';
-- At most one active (queued/running) job per run — idempotent enqueue under
-- duplicate triggers; prevents two workers double-driving one run.
CREATE UNIQUE INDEX idx_run_jobs_run_active ON run_jobs(run_id) WHERE status IN ('queued', 'running');
```

**One store object, several interfaces.** Both `MemoryRunStore` and `PgRunStore` implement `RunStore` **and** `ThreadStore`, `OAuthStore`, and `ScheduleStore` on a single object — a unified store facade. Callers depend on the narrow interface they need (the gateway passes the same instance as `store`, `threadStore`, `oauthStore`, and `scheduleStore`), so there is one connection pool and one migration path behind all four.

**Contract** — [`EventLogStore`](05-type-reference.md#eventlogstore), [`RunEvent`](05-type-reference.md#runevent) / [`RunEventRecord`](05-type-reference.md#runeventrecord), [`RunStore`](05-type-reference.md#runstore), [`RunRecord`](05-type-reference.md#runrecord), [`SpanRecord`](05-type-reference.md#spanrecord), [`JobQueue`](05-type-reference.md#jobqueue), [`JobRecord`](05-type-reference.md#jobrecord).

---

## Threads

**Purpose** — The gateway tracks multi-turn work as **threads**. A **thread** is the top-level unit of work: a durable, ordered line of work — a sequence of messages — owned by a `userId` and carrying arbitrary `metadata`. It may be **autonomous** (a workflow root that drives to completion with no external input — Lane A) or **interactive** (a chat surface that takes one user turn at a time — Lane B). Per [D12](00-foundations.md#d12--two-execution-lanes-durable-workflows-vs-interactive-chat) these are *different lanes*, not the same long-lived run: a chat thread accrues turns as a series of short runs, while a workflow thread is one durable run. There is no separate "session" grouping — "everything a user is doing" is just the threads with that `userId`.

**Model** — A **thread spans a *sequence* of runs** over its lifetime, with **at most one active run at a time** (the partial unique index). The thread is the stable identity and message history; for a chat thread, **each user turn is its own short run**. The thread's full turn history lives in the event log across its runs (`messages`/`run_messages` keyed by `threadId`), so it survives — and outlives — any single run.

**How threads relate to execution — two execution modes.** For a chat thread the gateway **opens a new run per message turn** (`submitRootRun`) and then **attaches**: it tails the event log *out* over SSE (the stream spans every run in the thread, filtered by `threadId`). *Where* the turn is driven depends on the mode:

- **Queue mode (production):** the gateway is a thin web service — it proxies, it does not execute. It enqueues an `agent` job to the [`run_jobs` queue](#store--postgres-schema) and returns `202`; the **warm chat worker** (Lane B) claims the job and drives that one turn to completion in-process.
- **Inline execution mode (local dev / tests):** with no worker wired, the gateway drives the turn itself, in-process, at enqueue time — `driveAgentTurn` for a fresh turn and `resumeRun` for a resume — via the job's `driveInline` callback (`packages/gateway/src/app.ts:169`).

**Turn-end completes the run; memory comes from the transcript.** A chat turn is *not* a parked run — when the model's turn finishes, the run reaches a terminal state. Conversational memory is reconstructed per turn from **thread-scoped history**: a new turn's run assembles its model-visible messages from *every run in the thread* (`getThreadAgentMessages`, ordered by run start then sequence), so context accrues across runs without any run staying alive. Because that transcript is kept beyond the event horizon (unlike `run_events`), a thread stays continuable even after old runs' detail has been trimmed. The single-active-run index serializes turns; while a turn is still generating, an incoming message returns `409 thread_busy`.

**Within-turn HITL is the only pause.** If a tool inside a turn needs a human (`requestApproval` or `awaitInput`), *that turn's run* pauses (`reason: "approval"` / `"input"`) and resumes via a durable `resume` job (queue mode) or an inline `resumeRun` (inline mode) — see [HITL pause & resume](02-execution.md#hitl-pause--resume) / [`/runs/:id/input`](#gateway). This is distinct from turn-taking: the gateway routes resume by the pause reason, and a chat container is never pinned merely waiting for the *next* turn.

**Busy vs. input-pause on `POST /threads/:id/messages`.** The single-active-run index serializes turns, so an incoming message is handled by the state of the thread's active run:

- **`running`/`pending`** → `409` `{ error: "Thread is busy (active run mid-turn)", runId }` (the DB partial-unique index is the backstop if a concurrent message slips past the soft check).
- **`paused` for `"approval"`** → `409` `{ error: "Run is paused awaiting approval; resolve it via POST /approvals/:id/resolve", runId }` — a message can't clear an approval pause.
- **`paused` for `"input"`** → the message *is* the awaited input: the gateway appends `message.user` and resumes the same run, returning **`200` `{ runId, delivered: true }`** (not `202` — this feeds an existing run rather than opening one).
- **No active run** → opens a new run for the turn and returns `202` (`{ runId, dispatched: true, agent }`).

**Agent binding is gateway-level, not per-thread.** The conversational agent/workflow for a thread comes from **gateway boot config** — `defaultAgent` (preferred; an interactive agent run per turn) or, failing that, `defaultWorkflow` — *not* from a `workflow` field on the thread. `POST /threads` accepts only `{ userId?, metadata?, title? }`. (Per-thread agent selection is a possible future extension.) Multi-turn *memory* lives in the thread's event log (keyed by `threadId`), not in gateway memory; every turn's run reads that history and treats the new message as "continue this thread."

**Contract** — [`Thread`](05-type-reference.md#thread), [`ThreadMessage`](05-type-reference.md#threadmessage), [`ThreadStore`](05-type-reference.md#threadstore).

---

## Approvals

**Purpose** — Production HITL persists approval requests so a paused run can be resolved by a human out-of-band, then resumed.

**Model** — Approval events are the canonical source of truth. When a gated tool requests approval in production, the runner emits an `approval.requested` event (projected into `approval_requests` with `status: "pending"`) and the run pauses. Pending approval is "requested with no matching resolved event." An operator lists pending approvals and resolves each, which emits `approval.resolved` (`approved` / `denied`, optional `resolvedBy` / `reason`). Resolution drives the run's resume — see [Execution → HITL pause & resume](02-execution.md#hitl-pause--resume).

**Approvals are projection-only; there is no active approval-store write path.** The gateway reads from the folded `approval_requests` projection (`store.listApprovals()`) and writes only by appending `approval.resolved` **events** — it never calls a store method to create or resolve an approval. The [`ApprovalStore`](05-type-reference.md#approvalstore) interface (`createRequest` / `resolve` / `listPending`) is defined but **not wired** into the gateway; approval state lives entirely in the event log and its projection.

**Listing.** `GET /approvals` **defaults to `status=pending`** (the operator action queue); `?status=approved|denied` powers the resolved-history view and `?status=all` returns every approval. An optional `?threadId=` filter scopes results to one thread — approvals carry only a `runId`, so the gateway resolves each candidate's `threadId` server-side. The response JSON exposes the projection's `input` field (the tool input) directly; note the wire shape uses `input` where [`ApprovalRequest`](05-type-reference.md#approvalrequest) names it `toolInput`.

**Contract** — [`ApprovalRequest`](05-type-reference.md#approvalrequest), [`ApprovalStore`](05-type-reference.md#approvalstore) (interface only — not the active write path; see above).

---

## OAuth & multi-tenancy

**Purpose** — Tools that act on a user's behalf need per-user credentials, scoped by the run's identity rather than a shared global token.

**Model** — An `OAuthConnection` stores a provider's tokens for a `(userId, provider)` pair (access/refresh tokens encrypted at rest, with scopes). The run's `userId` — captured from the gateway's auth and propagated through `DispatchOptions` to child runs and subagents — is what `ToolContext.connection(provider)` resolves against the `OAuthStore`. When there is no user (system/cron runs) or no stored connection, `connection()` returns `undefined`, and OAuth-dependent tools should return a clear error result rather than throwing.

**Routes are optional.** The OAuth routes (`/oauth/:provider/*`) **and** `GET /connections` are registered **only when `oauthProviders` is configured** at boot. With no providers configured they are never mounted, so requests fall through to the gateway's `404` — OAuth is opt-in, letting the operator UI gate its connections nav on their presence.

- **Authorize** (`GET /oauth/:provider/authorize?userId=`) redirects to the provider with an HMAC-signed `state` carrying the `userId`.
- **Callback** (`GET /oauth/:provider/callback`) exchanges the code for tokens, persists them encrypted, and returns **JSON `{ status: "connected", provider, userId }`** — it does *not* issue an HTML redirect back to an app.
- **Connections** (`GET /connections`, optional `?userId=`) lists the configured providers and, when a `userId` is supplied, whether that user has a live connection (`{ providers: [{ provider, connected, scopes?, expiresAt? }] }`) — a read-only status feed for the operator UI.
- **Revoke** (`DELETE /oauth/:provider?userId=`) deletes the stored connection.

**Contract** — [`OAuthConnection`](05-type-reference.md#oauthconnection), [`OAuthStore`](05-type-reference.md#oauthstore), [`OAuthTokens`](05-type-reference.md#oauthtokens).

---

## Webhooks

**Purpose** — Inbound external events (e.g. a GitHub push) trigger workflow runs. User-authored adapters live under `webhooks/` and are auto-discovered.

**Model** — A `WebhookAdapter` exposes a `name`, a `match(req)` that returns a `WebhookMatch` (the target `workflow` + `trigger`) or `null`, and a `parse(req)` that extracts the workflow input. The gateway mounts each adapter at `POST /webhooks/:name` and dispatches with the **parsed** input — `workflow.dispatch(await adapter.parse(req), match.trigger)`. User-authored webhooks and package-contributed [connectors](#connectors) share the same dispatch mechanism but live in separate namespaces (no collisions). The webhook/connector routes are **mounted only when at least one webhook or connector map is non-empty**; with neither configured they are never registered.

**Contract** — [`WebhookAdapter`](05-type-reference.md#webhookadapter), [`WebhookMatch`](05-type-reference.md#webhookmatch).

---

## Connectors

**Purpose** — Tool packages can contribute inbound webhook endpoints alongside their tools. This is how GitHub, Slack, and Linear integrations register their own webhook receivers.

**Model** — A `ConnectorSpec` exposes a route `key` (mounted at `/connectors/:key`), a `name`, and a `handle(req, ctx)` that returns a `WebhookMatch` (a workflow dispatch) or `null`. Connectors are contributed by tool packages via an optional `connectors` export; the gateway auto-discovers them at startup and mounts each at `/connectors/:key`. On a match, the connector dispatches with the **raw `Request`** as input — `workflow.dispatch(req, match.trigger)` — leaving payload parsing to the target workflow (unlike webhooks, which parse via `adapter.parse()` first).

**Contract** — [`ConnectorSpec`](05-type-reference.md#connectorspec), [`ConnectorContext`](05-type-reference.md#connectorcontext).

---

## Schedules

**Purpose** — Workflows can run on a cron schedule, either via Render Cron config or via a runtime-managed schedule store.

**Model** — A `ScheduleRecord` pairs a `workflow` with a `cronExpression`, optional `input`, an `enabled` flag, and last-run bookkeeping. Two complementary paths:

- **Static (still supported):** a cron entry in `render.yaml` hits `POST /workflows/:name` directly — no schedules table involved. Best for a fixed, deploy-time schedule.
- **Runtime-managed (the `ScheduleStore`):** schedules are CRUD records created at runtime against the `schedules` table, dispatched by a **reconciler**. The reconciler is driven by a single per-minute **tick** — `POST /admin/schedules/tick` (authed; wired to a per-minute Render Cron, the same operational pattern as `/admin/retention`) — so no in-process timer is needed. On each tick the reconciler loads enabled schedules, selects those whose 5-field cron matches the current minute and that have not already fired this minute (`lastRunAt`-based dedupe, so retried/overlapping ticks are idempotent), dispatches each workflow (trigger `"cron"`), and stamps `lastRunId`/`lastRunAt`. Cron resolution is minute-granular and evaluated in UTC. Schedules are operational data and are never auto-expired (see [Operations → Retention](04-operations.md#retention)); `last_run_id` is `ON DELETE SET NULL` so a schedule survives the trimming of the run it last triggered.

**Validation.** `POST /schedules` requires a `workflow` that is a **registered workflow name** (`400` if missing or unknown) and a `cronExpression` that passes `validateCron` (`400` on a malformed cron); it returns `201` with the created record. `PATCH /schedules/:id` accepts partial updates to `workflow`, `cronExpression`, `input`, and `enabled`, re-running the same validation on any field present — an unknown `workflow` or invalid `cronExpression` is a `400`.

**Routes** — `POST /schedules` (create), `GET /schedules` (list), `GET /schedules/:id`, `PATCH /schedules/:id` (workflow / cron / input / enabled), `DELETE /schedules/:id`, and `POST /admin/schedules/tick` (reconcile).

**Contract** — [`ScheduleRecord`](05-type-reference.md#schedulerecord), [`ScheduleStore`](05-type-reference.md#schedulestore).

---

## Gateway

**Purpose** — The gateway is the web service: it exposes runs, threads, HITL, OAuth, webhooks, and SSE streaming over HTTP, and is the single entry point for triggering and observing work.

**Model** — Routes:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/workflows/:name` | Dispatch a workflow run — body `{ input, trigger? }`; `input` required |
| `GET` | `/workflows` | List registered workflow names (+ `defaultWorkflow`) |
| `GET` | `/runs` | List runs (keyset pagination; roots-only by default) |
| `GET` | `/runs/:id` | Run details + `aggregateCostUsd` (all-in cost) |
| `GET` | `/runs/:id/children` | Child runs spawned by this run (cross-run trace stitching) |
| `GET` | `/runs/:id/spans` | Span tree for a run |
| `GET` | `/runs/:id/tool-calls` | Tool calls + results for a run |
| `GET` | `/runs/:id/events` | Ordered raw event log for a run (debug lens; optional `?seq=`) |
| `GET` | `/runs/:id/stream` | SSE stream of run events (+ live token deltas) |
| `POST` | `/runs/:id/cancel` | Request cancel of a `pending`/`running`/`paused` run (async) |
| `POST` | `/runs/:id/input` | HITL resume (routes by pause reason: user input or approval) |
| `POST` | `/threads` | Create a thread (`{ userId?, metadata?, title? }`) |
| `GET` | `/threads` | List threads (optional `?userId=`) |
| `GET` | `/threads/:id` | Thread metadata + human transcript (`{ thread, messages }`) |
| `POST` | `/threads/:id/messages` | Send a message — opens a new run (`202`) or feeds an input-paused run (`200`); `409` if busy / approval-paused |
| `GET` | `/threads/:id/stream` | SSE stream for a thread (spans the thread's runs, live tail) |
| `GET` | `/approvals` | List approvals (defaults `status=pending`; `?status=all\|approved\|denied`, `?threadId=`) |
| `POST` | `/approvals/:id/resolve` | Approve or deny a tool call |
| `POST` | `/webhooks/:name` | Inbound webhook dispatch (user-authored; mounted only if configured) |
| `POST` | `/connectors/:key` | Inbound webhook dispatch (package-contributed; mounted only if configured) |
| `POST` | `/schedules` | Create a runtime-managed schedule |
| `GET` | `/schedules` | List schedules |
| `GET` | `/schedules/:id` | Schedule details |
| `PATCH` | `/schedules/:id` | Update workflow / cron / input / enabled |
| `DELETE` | `/schedules/:id` | Delete a schedule |
| `POST` | `/admin/schedules/tick` | Reconcile + fire due schedules (per-minute cron) |
| `POST` | `/admin/retention` | Run retention cleanup (daily cron) |
| `POST` | `/admin/runs/reap` | Fail stranded Lane A roots (periodic cron) |
| `GET` | `/admin/jobs` | Chat-lane queue depth (`run_jobs` counts by status + backlog) |
| `GET` | `/events/stream` | Global operator event tail (durable events only, enriched with `runId`) |
| `GET` | `/oauth/:provider/authorize` | OAuth initiation (only if OAuth configured) |
| `GET` | `/oauth/:provider/callback` | OAuth callback → JSON `{ status: "connected", … }` (only if configured) |
| `DELETE` | `/oauth/:provider` | Revoke + delete OAuth connection (only if configured) |
| `GET` | `/connections` | Provider list + per-user connected status (only if OAuth configured) |
| `GET` | `/ui`, `/ui/*` | Operator UI SPA (unauthenticated shell; see [Operator UI](06-operator-ui.md)) |
| `GET` | `/health` | Health check (unauthenticated) |

**Dispatch (`POST /workflows/:name`).** Body is `{ input, trigger? }`. `input` must be present and non-empty (`400` otherwise); an unknown workflow is `404`. On success the run is dispatched and the route returns **`202`** with the run record.

**Run listing & pagination (`GET /runs`).** Keyset pagination via a `before` cursor (a run id) plus `limit`. It returns **top-level roots by default** (`roots=true`) — child runs from workflow fan-out / subagents are excluded so the list isn't cluttered; pass `?roots=false` to include them. Also filterable by `?workflow=` and `?status=`.

**Run details (`GET /runs/:id`).** Returns the run record **plus `aggregateCostUsd`** — the all-in cost including subagent descendants (see [Observability → Cost](#observability)). It does **not** embed messages; fetch those via `/runs/:id/tool-calls`, `/runs/:id/events`, or the thread transcript.

**Cancel (`POST /runs/:id/cancel`).** Accepts a run in `pending`, `running`, **or** `paused` (`409` if already terminal). It calls `cancelStore.requestCancel(id)` and **returns immediately** with `{ status: "cancelled", runId }` — this is an async *request*, not confirmation; the canonical terminal transition is the `run.cancelled` event the loop appends when it next checks. The `PgCancelStore` implements this by directly writing `runs.status = 'cancelled'` as the request flag — the **one sanctioned exception to D10's "everything is a projection"** rule (a directly-written *request*, not authoritative state).

**HITL resume — two paths.** A run pauses for `"approval"` or `"input"`, and there are two ways to resume it:

- `POST /approvals/:id/resolve` — appends `approval.resolved` for a specific approval, then resumes its run.
- `POST /runs/:id/input` — **routes by the run's most recent `run.paused` reason**: an `"input"` pause consumes `{ content }` (appended as `message.user`), an `"approval"` pause consumes `{ approvalId, approved?, resolvedBy?, reason? }` (appended as `approval.resolved`). A `400` results if the required field for the reason is missing.

In both cases the resume driver is **fire-and-forget by default** — the HTTP call returns as soon as the resolution event is durably recorded, without waiting for the run to finish. Setting `awaitResume` (tests) blocks the response on the resume; either way a resume failure is isolated and never masks the recorded resolution.

**Authentication (7.6):**

- API-key **bearer** auth (`Authorization: Bearer <key>`) for programmatic access, compared in constant time.
- **`?key=` query fallback** for `EventSource`/SSE clients, which cannot set headers (used by the live trace/stream views).
- **Fail-closed on misconfig:** if the server's API key env is unset, protected routes return **`500`** ("Server misconfigured"), not `401`.
- The **UI shell + assets (`/ui`) and `/health` are unauthenticated** (registered before the auth middleware); data fetches from the UI still carry the API key.
- Threads are owned by `userId` (from auth) for ownership/filtering — there is no separate session token; per-user OAuth connections are injected into tool context.

**SSE streaming.** The SSE stream is a **live tail of the durable event log** (`RunStore.events.tail`) over Postgres `LISTEN/NOTIFY`, **merged with a transient token-delta side channel** (D13). There is no separate SSE event vocabulary to keep in sync; clients receive the same [`RunEvent`](05-type-reference.md#runevent) taxonomy that is persisted, plus non-durable `text.delta` frames.

- **Payload strategy:** NOTIFY payloads are pointer-sized (`{ runId, seq }`), not full records. The handler fetches the event by `(runId, seq)` and serializes it. This keeps NOTIFY payloads small and avoids Postgres payload size limits.
- **Channel:** A single NOTIFY channel (`run_events`) carries every appended event; the handler filters by `runId` or `threadId`.
- **Events:** the full `RunEvent` taxonomy — lifecycle (`run.*`), message (`message.*`), tool (`tool.called`/`tool.result`), step, model (`llm.call`), approval (`approval.requested`/`resolved`/`auto`), delegation (`subagent.spawned`), context (`context.compacted`). Subscribe by category, not by individual name. This taxonomy maps directly onto AG-UI for frontend interop.
- **Token deltas (D13, implemented):** `text.delta` token-level streaming **is live**, not post-MVP. Transient deltas ride a separate `DeltaBus` (Postgres `run_deltas` NOTIFY channel / in-memory bus), are merged into the run and thread SSE streams alongside durable events, and are **rejected from the durable append path** (they are never persisted). Deltas carry **no SSE `id`**, so they never move the reconnect cursor; a reconnecting client skips them and converges on the durable `message.assistant`.
- **Run stream (`/runs/:id/stream`)** does a **catch-up replay** first — `events.read(runId, fromSeq)` from the `?seq=`/`Last-Event-ID` offset — then tails live. It **closes** when the run reaches a terminal state (`run.completed` / `run.failed` / `run.cancelled`) and **stays open while `paused`** (so a HITL resume streams through the same connection).
- **Global operator tail (`/events/stream`)** tails **all** runs (no `runId`/`threadId` filter), emits **durable events only** (no delta merge), and enriches each frame's payload with the `runId` (and `seq`, `category`, `type`, span ids) so an operator rail can attribute events across runs.
- **Thread streams (`/threads/:id/stream`)** stay open across the thread's runs — when a thread accrues a new run, that run's events carry the same `threadId`, so the tail (filtered by `threadId`) picks them up automatically without the client reconnecting. Like the run stream, the thread stream does a **catch-up replay** on connect (`events.readThread(threadId)`, ordered by `ts, runId, seq`) from the `Last-Event-ID` cursor, then tails live — so a reconnect backfills events missed while disconnected rather than only seeing new ones.
- **SSE `id` cursors:** the single-run stream uses the numeric per-run `seq` (unambiguous within one run). The **thread and global streams use a composite `runId:seq`** id, because per-run `seq` restarts at 1 and would otherwise collide across a thread's runs — so `Last-Event-ID` is a collision-free reconnect cursor on every stream. Transient `text.delta` frames still carry no id.
- The **global tail is live-tail only** by design: a connect-time replay of the whole log would be unbounded, so clients (the operator rail) refetch counts via REST on (re)connect and the tail carries only new events; the composite id keeps de-dup reliable.

---

## Observability

**Purpose** — Observable by default: every execution unit is a span, with cost attribution — full visibility requires no external collector. The trace tree is a **projection of the event log**: spans are folded from span-producing events, so observability needs no separate instrumentation path.

**Model** — Every execution unit is a span (a fold of its `*.started`/`*.completed` events), and the hierarchy mirrors the execution tree:

```
workflow run (trace root)
├── step: prepareDiff (deterministic)
├── agent: security (task)
│   ├── llm: turn 0
│   │   └── tool: github__get_file
│   ├── llm: turn 1
│   │   └── tool: sandbox__run_test
│   └── llm: turn 2 (final)
├── agent: performance (task, parallel)
│   └── ...
├── agent: ux (task, parallel)
│   └── ...
├── agent: judge (in-process)
│   └── llm: turn 0 (final)
└── step: postReview (deterministic)
```

**Subagents are a cross-run hierarchy, not a single-run span tree.** A spawned subagent is its **own run**, linked to its parent by [`runs.parent_span_id`](#store--postgres-schema) (the `subagents__<name>` tool span it hangs off) — not a child span inside the parent run's span table. The parent run records a `tool` span for the `subagents__<name>` call and a **log-only** `subagent.spawned` event carrying the `childRunId`; the child's spans live under the child run. The operator UI **stitches** the delegation tree at read time by following `GET /runs/:id/children` (backed by `listChildRuns`, which matches child runs whose `parentSpanId` falls within the parent run) together with the `subagent.spawned` events. Conceptually the stitched view is:

```
run: planner (task)                          ← parent run
└── llm: turn 1
    └── tool: subagents__researcher          ← parent_span_id of the child run
        └── run: researcher (task)           ← separate child run, stitched in
            └── llm: turn 0 (final)
```

**Span attributes:**

| Unit | Span kind | Required attributes |
|---|---|---|
| Workflow run | `workflow` | workflow name, trigger type, input summary |
| Deterministic step | `step` | step name |
| Agent invocation | `agent` | agent name, **agent version**, model, final token usage, iteration count |
| LLM call | `llm` | model, input tokens, output tokens, stop reason, latency ms |
| Tool call | `tool` | tool name, latency ms, success/error |

The built-in `load_skill` tool appears as an ordinary `tool` span — tool name `load_skill`, with the loaded skill `id` in attributes — so skill usage is visible in the trace without a dedicated span kind. Postgres is the source of truth; export to external collectors (Datadog, Honeycomb, Grafana) is via an optional OTel exporter — not required for full visibility.

**Attribute folding.** Span attributes are folded from the event log, identically across the in-memory and Postgres stores (enforced by the parity suite):

- The **`workflow` root span** is folded from a `run.started` carrying `spanKind: "workflow"` (a `workflow()` dispatch); an agent invocation's `run.started` defaults to an `agent` root span.
- An **`agent` span**'s `model` / `iterations` / `usage` accumulate from the run's `llm.call` events (`agentVersion`/`model` seeded by `run.started`), so the span reports final token usage and turn count when it closes.
- **`llm` spans** carry both the native attribute keys (`usage`, `costUsd`, `stopReason`, `latencyMs`) and OTel `gen_ai.*` semantic-convention aliases (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`) for exporters.
- **`tool` spans** carry `toolName`, a boolean `ok`, and a `latencyMs` derived from the span's own start/finish (store-local, not a cross-store fold invariant).

**Cost attribution — per-run fold vs. all-in aggregate.** Each LLM span carries `inputTokens`, `outputTokens`; cost is computed from the model's pricing table and accumulated in the agent span. A run's **`total_cost_usd` is a pure per-run fold of that run's own `llm.call` events** — it does *not* include the cost of subagents (which are separate runs). Cross-run delegation cost is a **read-layer aggregate**: `aggregateRunCost` walks `subagent.spawned.childRunId` across runs (cycle-guarded) to sum a run's own cost plus every descendant's, and the gateway exposes the result as **`aggregateCostUsd` on `GET /runs/:id`**. So `total_cost_usd` answers "what did this run spend directly" and `aggregateCostUsd` answers "what did this run and its whole delegation subtree spend."

**Contract** — [`Tracer`](05-type-reference.md#tracer), [`SpanInfo`](05-type-reference.md#spaninfo), [`SpanKind`](05-type-reference.md#spankind), [`SpanRecord`](05-type-reference.md#spanrecord).
