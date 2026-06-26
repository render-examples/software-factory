# Operations

**Layer:** L4 — *how you deploy & operate.* Part of the [render-agents specification](00-foundations.md) ([Document Map](00-foundations.md#document-map)).

This layer covers running the system in production: the deployment topology, configuration via environment variables, data retention, and the non-functional targets the SDK is held to. The platform substrate these operate on lives in [Platform](03-platform.md); exact type shapes live in the [Type Reference](05-type-reference.md).

Each section follows the same shape: **Purpose** (what & why), **Model** (how it works), and an **Example** where useful.

---

## Deployment model

**Purpose** — A production deployment is a small set of Render primitives wired together: the same agent definitions run locally and in production with one config file.

**Model** — Target architecture:

```
┌─────────────────────────────────────────────────────────┐
│                    Trigger surfaces                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐   │
│  │ Webhooks │  │   Cron   │  │  HTTP/Chat requests  │   │
│  └────┬─────┘  └────┬─────┘  └──────────┬───────────┘   │
│       │              │                   │              │
│       ▼              ▼                   ▼              │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Web Gateway (Hono)                   │  │
│  │  Sessions, HITL, OAuth, SSE, webhook dispatch    │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                               │
│                         ▼                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Render Workflows (orchestration)        │   │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌───────┐   │   │
│  │  │security│  │  perf  │  │   ux   │  │ judge │   │   │
│  │  │ (task) │  │ (task) │  │ (task) │  │ (run) │   │   │
│  │  └────────┘  └────────┘  └────────┘  └───────┘   │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                               │
│                         ▼                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │   Postgres: run_events log → projections          │  │
│  │   (runs, spans, messages, approvals) + OAuth      │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**`render.yaml`** — a production deployment consists of:

- **Web service** — the gateway (Hono), webhook ingress, SSE, HITL.
- **Workflow service** — workflow definitions + agent tasks.
- **Postgres** — all durable state.
- **Cron** (optional) — scheduled workflow triggers.
- **Private services** (optional) — MCP servers, custom tool backends.

---

## Configuration

**Purpose** — There is no project-level config file. Each concern has its own home, so nothing duplicates what is already expressed in markdown frontmatter, `package.json`, or environment variables.

**Model** — Where each concern lives:

- **Agent defaults** (model, budget, permissions) → `agents/_shared.md` frontmatter
- **Project metadata** (name, version) → `package.json`
- **Deploy config** (services, databases) → `render.yaml`
- **Secrets and connection strings** → `.env` / Render environment variables
- **Retention policy** → `EVENT_RETENTION_DAYS`, `RUN_RETENTION_DAYS` env vars
- **Hooks** → auto-discovered from `hooks/` (no config; see [Authoring → Hooks](01-authoring.md#hooks))
- **Gateway port** → `PORT` env var
- **Auth** → `WORKFLOW_API_KEY` env var
- **Local strict approvals** → `RENDER_AGENTS_STRICT_APPROVAL` env var (see [Execution → HITL pause & resume](02-execution.md#hitl-pause--resume))

Store and dispatcher selection is also env-driven: `DATABASE_URL` selects Postgres vs in-memory, and `RENDER_SDK_SOCKET_PATH` / `RENDER_USE_LOCAL_DEV` select the Render Workflows dispatcher vs the in-process fallback (see [Execution → Runtime & composition](02-execution.md#runtime--composition)).

---

## Retention

**Purpose** — The event log accumulates fast; a default retention policy keeps it bounded while preserving user data. Because projections are folds of the log, they expire with their source events — there is one retention knob to reason about, not one per table.

**Model** — Default retention:

- Event log (`run_events`) and its projections (`spans`, `run_messages`, `tool_calls`, `workflow_steps`, `approval_requests`): 30 days, configurable via `EVENT_RETENTION_DAYS`
- Run summary records (`runs`): 90 days, configurable via `RUN_RETENTION_DAYS`
- Sessions/conversations: no automatic expiry (user data)
- Schedules: no automatic expiry (configuration data)

Trimming events trims their projections in the same pass; conversely, a projection can be rebuilt by replaying retained events. A background cleanup job runs daily (or on a Render Cron trigger).

---

## Non-functional requirements

**Purpose** — The targets the SDK is held to across runtime, build, and operational dimensions.

**Model:**

| Requirement | Target |
|---|---|
| Node version | 20+ |
| Module system | ESM only |
| TypeScript | Strict mode, declaration emit |
| Local dev without Postgres | In-memory store, full functionality |
| Agent load + validation | < 500ms for 20 agents |
| LLM loop overhead per turn | < 10ms (excluding model latency) |
| Event append latency | < 5ms (append + projection update, non-blocking) |
| SSE delivery latency | < 100ms from event append to client |
| Zero external dependencies for observability | Postgres is sufficient |
| Package size (`@render-agents/sdk`) | < 100KB minified |
