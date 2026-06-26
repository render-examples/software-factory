# Platform

**Layer:** L3 — *what persists & serves.* Part of the [render-agents specification](00-foundations.md) ([Document Map](00-foundations.md#document-map)).

This layer covers the durable substrate beneath the runtime: the Postgres schema, the stores for sessions, approvals, OAuth, webhooks, connectors, and schedules, the web gateway, and the observability model. Runtime behavior that drives these stores lives in [Execution](02-execution.md); exact type shapes live in the [Type Reference](05-type-reference.md).

Each section follows the same shape: **Purpose** (what & why), **Model** (how it works), **Contract** (link to exact types), and an **Example** where useful.

---

## Store & Postgres schema

**Purpose** — The append-only event log is the single source of truth. `run_events` is the canonical store; `runs`, `spans`, `run_messages`, `tool_calls`, `workflow_steps`, and `approval_requests` are **maintained projections** folded from it on append — kept as tables (not views) so existing indexes and query patterns stay fast. Sessions, conversations, OAuth, and schedules are independent operational tables.

**Model** — Writes go through `RunStore.events.append`, which (atomically) inserts the event, updates the affected projections, and `NOTIFY`s the stream. Migrations are applied by `RunStore.init()` under a Postgres advisory lock, in a single canonical **dependency order** so all foreign keys resolve:

1. `sessions`
2. `conversations` (FK → `sessions`)
3. `runs` (FK → `conversations`)
4. `run_events` (FK → `runs`) — the canonical log
5. `spans`, `tool_calls`, `run_messages`, `workflow_steps`, `approval_requests`, `schedules` (FK → `runs`) — projections + ops
6. `messages` (FK → `conversations`, `runs`)
7. `oauth_connections` (no FKs)

The blocks below document each table for reference; **they are not the application order** (creating `runs` before `conversations` would violate the FK). Each `CREATE TABLE` uses `IF NOT EXISTS` and is idempotent. **Event payloads are versioned and immutable** — history is never rewritten; schema changes add new event versions.

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

**`runs`** (projection) — summary row per workflow run or agent invocation; status = latest lifecycle event, `total_cost_usd` folds `llm.call` events. Maintained on append and often retained on a longer horizon than event-detail tables for low-cost operational history.

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
  conversation_id TEXT REFERENCES conversations(id),
  user_id         TEXT,
  agent_version   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX idx_runs_workflow ON runs(workflow);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_conversation ON runs(conversation_id);
CREATE INDEX idx_runs_user ON runs(user_id);
```

**`spans`** (projection) — the observability tree, folded from span-producing events (`*.started`/`*.completed`).

```sql
CREATE TABLE spans (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  parent_id   TEXT,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',
  input       JSONB,
  output      JSONB,
  error       TEXT,
  attributes  JSONB,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX idx_spans_run_id ON spans(run_id);
```

**`tool_calls`** (projection) — folded from `tool.called`/`tool.result` events for fast idempotency lookups. `RunContext.appliedToolResult` reads it before dispatching a tool; if a result exists, it short-circuits. (The events are canonical; this table is the index over them.)

```sql
CREATE TABLE tool_calls (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  idempotency_key TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  input           JSONB,
  result_content  TEXT,
  result_is_error BOOLEAN DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'pending',
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

**`sessions`** — user sessions.

```sql
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT,
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**`conversations`** — multi-turn conversations within a session. The partial unique index enforces at most one active run per conversation, preventing concurrent turns from corrupting message history.

```sql
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_session ON conversations(session_id);

-- At most one active (pending/running/paused) run per conversation.
-- Prevents concurrent turns from corrupting message history.
CREATE UNIQUE INDEX idx_runs_conversation_active
  ON runs(conversation_id)
  WHERE status IN ('pending', 'running', 'paused');
```

**`messages`** — user/assistant conversation turns (distinct from the LLM-loop `run_messages`).

```sql
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  run_id          TEXT REFERENCES runs(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id);
```

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

**`schedules`** — runtime-managed scheduled triggers.

```sql
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  workflow        TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  input           JSONB,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_run_id     TEXT REFERENCES runs(id),
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

**Contract** — [`EventLogStore`](05-type-reference.md#eventlogstore), [`RunEvent`](05-type-reference.md#runevent) / [`RunEventRecord`](05-type-reference.md#runeventrecord), [`RunStore`](05-type-reference.md#runstore), [`RunRecord`](05-type-reference.md#runrecord), [`SpanRecord`](05-type-reference.md#spanrecord).

---

## Sessions & conversations

**Purpose** — The gateway tracks multi-turn interactions: a session groups a user's conversations, and a conversation is an ordered series of turns where each turn triggers a run.

**Model** — A session belongs to an optional `userId` and carries arbitrary metadata. A conversation belongs to a session and accumulates `ConversationMessage`s (user/assistant turns), each optionally linked to the `runId` that produced it. At most one active run is permitted per conversation (enforced by the partial unique index above), so concurrent turns cannot corrupt history.

**Contract** — [`Session`](05-type-reference.md#session), [`Conversation`](05-type-reference.md#conversation), [`SessionStore`](05-type-reference.md#sessionstore).

---

## Approvals

**Purpose** — Production HITL persists approval requests so a paused run can be resolved by a human out-of-band, then resumed.

**Model** — Approval events are the canonical source of truth. When a gated tool requests approval in production, the runner emits an `approval.requested` event (projected into `approval_requests` with `status: "pending"`) and the run pauses. Pending approval is "requested with no matching resolved event." An operator lists pending approvals and resolves each, which emits `approval.resolved` (`approved` / `denied`, optional `resolvedBy` / `reason`). Resolution drives the run's resume — see [Execution → HITL pause & resume](02-execution.md#hitl-pause--resume).

**Contract** — [`ApprovalRequest`](05-type-reference.md#approvalrequest), [`ApprovalStore`](05-type-reference.md#approvalstore).

---

## OAuth & multi-tenancy

**Purpose** — Tools that act on a user's behalf need per-user credentials, scoped by the run's identity rather than a shared global token.

**Model** — An `OAuthConnection` stores a provider's tokens for a `(userId, provider)` pair (access/refresh tokens encrypted at rest, with scopes). The run's `userId` — captured from the gateway's auth and propagated through `DispatchOptions` to child runs and subagents — is what `ToolContext.connection(provider)` resolves against the `OAuthStore`. When there is no user (system/cron runs) or no stored connection, `connection()` returns `undefined`, and OAuth-dependent tools should return a clear error result rather than throwing.

**Contract** — [`OAuthConnection`](05-type-reference.md#oauthconnection), [`OAuthStore`](05-type-reference.md#oauthstore), [`OAuthTokens`](05-type-reference.md#oauthtokens).

---

## Webhooks

**Purpose** — Inbound external events (e.g. a GitHub push) trigger workflow runs. User-authored adapters live under `webhooks/` and are auto-discovered.

**Model** — A `WebhookAdapter` exposes a `name`, a `match(req)` that returns a `WebhookMatch` (the target `workflow` + `trigger`) or `null`, and a `parse(req)` that extracts the workflow input. The gateway mounts each adapter at `POST /webhooks/:name`. User-authored webhooks and package-contributed [connectors](#connectors) share the same dispatch mechanism but live in separate namespaces (no collisions).

**Contract** — [`WebhookAdapter`](05-type-reference.md#webhookadapter), [`WebhookMatch`](05-type-reference.md#webhookmatch).

---

## Connectors

**Purpose** — Tool packages can contribute inbound webhook endpoints alongside their tools. This is how GitHub, Slack, and Linear integrations register their own webhook receivers.

**Model** — A `ConnectorSpec` exposes a route `key` (mounted at `/connectors/:key`), a `name`, and a `handle(req, ctx)` that returns a `WebhookMatch` (a workflow dispatch) or `null`. Connectors are contributed by tool packages via an optional `connectors` export; the gateway auto-discovers them at startup and mounts each at `/connectors/:key`.

**Contract** — [`ConnectorSpec`](05-type-reference.md#connectorspec), [`ConnectorContext`](05-type-reference.md#connectorcontext).

---

## Schedules

**Purpose** — Workflows can run on a cron schedule, either via Render Cron config or via a runtime-managed schedule store.

**Model** — A `ScheduleRecord` pairs a `workflow` with a `cronExpression`, optional `input`, an `enabled` flag, and last-run bookkeeping. **MVP:** scheduled triggers use Render Cron directly in `render.yaml` — a cron job hits `POST /workflows/:name` on a schedule, with no schedules table, runtime API, or reconciliation needed. The `ScheduleStore` interface and `schedules` table are the contract for runtime-managed schedules in a future sprint.

**Contract** — [`ScheduleRecord`](05-type-reference.md#schedulerecord), [`ScheduleStore`](05-type-reference.md#schedulestore).

---

## Gateway

**Purpose** — The gateway is the web service: it exposes runs, sessions, HITL, OAuth, webhooks, and SSE streaming over HTTP, and is the single entry point for triggering and observing work.

**Model** — Routes:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/workflows/:name` | Dispatch a workflow run |
| `GET` | `/runs` | List runs (keyset pagination) |
| `GET` | `/runs/:id` | Run details + messages |
| `GET` | `/runs/:id/spans` | Span tree for a run |
| `GET` | `/runs/:id/tool-calls` | Tool calls + results for a run |
| `GET` | `/runs/:id/stream` | SSE stream of run events |
| `POST` | `/runs/:id/cancel` | Cancel a running or paused run |
| `POST` | `/runs/:id/input` | HITL resume (approval or user input) |
| `POST` | `/sessions` | Create a session |
| `POST` | `/sessions/:id/messages` | Send a message (triggers workflow) |
| `GET` | `/sessions/:id/conversations` | List conversations |
| `GET` | `/sessions/:id/conversations/:cid/stream` | SSE stream (cross-run, stays open) |
| `GET` | `/approvals` | List pending approvals |
| `POST` | `/approvals/:id/resolve` | Approve or deny a tool call |
| `POST` | `/webhooks/:name` | Inbound webhook dispatch (user-authored) |
| `POST` | `/connectors/:key` | Inbound webhook dispatch (package-contributed) |
| `GET` | `/oauth/:provider/authorize` | OAuth initiation |
| `GET` | `/oauth/:provider/callback` | OAuth callback |
| `DELETE` | `/oauth/:provider` | Revoke + delete OAuth connection |
| `GET` | `/health` | Health check |

**Authentication:**

- API key bearer auth (`Authorization: Bearer <key>`) for programmatic access.
- Session-based auth for multi-turn conversations.
- Per-user OAuth connections injected into tool context.

**SSE streaming.** The SSE stream is simply a **live tail of the event log** (`RunStore.events.tail`) over Postgres `LISTEN/NOTIFY` — there is no separate SSE event vocabulary to keep in sync; clients receive the same [`RunEvent`](05-type-reference.md#runevent) taxonomy that is persisted.

- **Payload strategy:** NOTIFY payloads are pointer-sized (`{ runId, seq }`), not full records. The handler fetches the event by `(runId, seq)` and serializes it. This keeps NOTIFY payloads small and avoids Postgres payload size limits.
- **Channel:** A single NOTIFY channel (`run_events`) carries every appended event; the handler filters by `runId` or `conversationId` and resumes from a `seq` offset on reconnect.
- **Events:** the full `RunEvent` taxonomy — lifecycle (`run.*`), message (`message.*`, `text.delta`), tool (`tool.called`/`tool.result`), step, model (`llm.call`), approval (`approval.requested`/`resolved`/`auto`), delegation (`subagent.spawned`), context (`context.compacted`). Subscribe by category, not by individual name. (`text.delta` token-level streaming is **post-MVP**, gated on `ModelClient.stream`; until then text arrives as `message.assistant` events.) This taxonomy maps directly onto AG-UI for frontend interop.
- **Conversation streams** stay open across runs — a new turn appends events under a new run; the tail (filtered by `conversationId`) picks them up automatically.

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

**Subagents** nest the same way: a `subagents__<name>` call is a `tool` span, and the spawned subagent's `agent` span is its child, so the full delegation hierarchy is visible:

```
agent: planner (task)
└── llm: turn 1
    └── tool: subagents__researcher
        └── agent: researcher (task)      ← depth + 1
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

The built-in `load_skill` tool appears as an ordinary `tool` span — tool name `load_skill`, with the loaded skill `id` in attributes — so skill usage is visible in the trace without a dedicated span kind. Attributes follow OTel semantic conventions where applicable (`gen_ai.*` namespace for LLM spans). Postgres is the source of truth; export to external collectors (Datadog, Honeycomb, Grafana) is via an optional OTel exporter — not required for full visibility.

**Cost attribution.** Each LLM span carries `inputTokens`, `outputTokens`. Cost is computed from the model's pricing table and accumulated in the agent span. The workflow run's total cost is the sum of its agent spans.

**Contract** — [`Tracer`](05-type-reference.md#tracer), [`SpanInfo`](05-type-reference.md#spaninfo), [`SpanKind`](05-type-reference.md#spankind), [`SpanRecord`](05-type-reference.md#spanrecord).
