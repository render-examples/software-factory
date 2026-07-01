# Operations

**Status:** DRAFT
**Date:** 2026-06-25

**Layer:** L4 — *how you deploy & operate.* Part of the [render-agents specification](00-foundations.md) ([Document Map](00-foundations.md#document-map)).

This layer covers running the system in production: the deployment topology, configuration via environment variables, data retention, and the non-functional targets the SDK is held to. The platform substrate these operate on lives in [Platform](03-platform.md); exact type shapes live in the [Type Reference](05-type-reference.md).

Each section follows the same shape: **Purpose** (what & why), **Model** (how it works), and an **Example** where useful.

---

## Deployment model

**Purpose** — A production deployment is a small set of Render primitives wired together: the same agent definitions run locally and in production with one config file.

**Model** — Target architecture. The gateway only *triggers* and *observes*; execution splits across the two lanes of [D12](00-foundations.md#d12--two-execution-lanes-durable-workflows-vs-interactive-chat) — durable **workflows** on Render Workflows (Lane A), interactive **chat turns** on a warm worker fed by the `run_jobs` queue (Lane B):

```
┌────────────────────────────────────────────────────────────────────┐
│                          Trigger surfaces                          │
│   ┌──────────┐   ┌──────────┐   ┌──────────────────────┐           │
│   │ Webhooks │   │   Cron   │   │  HTTP/Chat requests  │           │
│   └────┬─────┘   └────┬─────┘   └──────────┬───────────┘           │
│        ▼              ▼                     ▼                       │
│   ┌──────────────────────────────────────────────────┐            │
│   │              Web Gateway (Hono)                   │            │
│   │  Threads, HITL, OAuth, SSE, webhook dispatch     │            │
│   │  triggers roots (never runs an agent loop)        │            │
│   └──────┬──────────────────────────────┬────────────┘            │
│  Lane A  │ dispatchRoot (startTask)      │ enqueue run_jobs  Lane B │
│          ▼                               ▼                          │
│   ┌──────────────────────┐     ┌──────────────────────────┐        │
│   │  Workflows host       │     │   Chat worker (warm)     │        │
│   │  workflow@<plan> +    │     │   claims agent/resume    │        │
│   │  agent@<plan> tasks   │     │   jobs, drives one turn  │        │
│   │  (container per run)  │     │   in-process             │        │
│   └──────────┬───────────┘     └────────────┬─────────────┘        │
│              └──────────────┬───────────────┘                      │
│                             ▼                                       │
│   ┌────────────────────────────────────────────────────┐          │
│   │   Postgres: run_events log → projections            │          │
│   │   (runs, spans, messages, approvals) + run_jobs +   │          │
│   │   threads + schedules + OAuth                       │          │
│   └────────────────────────────────────────────────────┘          │
└────────────────────────────────────────────────────────────────────┘
```

**`render.yaml`** — the scaffolder (`create-render-agents`) emits this exact service inventory (each named `<name>-…` after the project):

- **`<name>-gateway`** — `web` service, the gateway (Hono): webhook/cron/chat ingress, SSE, HITL, OAuth. Triggers workflow roots via `startTask` and enqueues chat turns; it never executes an agent loop. Exposes an unauthenticated `GET /health` (the scaffolder sets `healthCheckPath: /health`) and serves the operator UI at `/ui` (the static shell is unauthenticated; UI data fetches carry the bearer key).
- **`<name>-workflows`** (Lane A) — `worker` service, the Render Workflows host: registers `workflow@<plan>` + `agent@<plan>` tasks; Render queues, provisions a container per run, and scales to zero.
- **`<name>-chat-worker`** (Lane B) — `worker` service, a long-lived background worker that claims `agent`/`resume` jobs from `run_jobs` and drives interactive turns in-process (warm, low-latency).
- **`<name>-db`** — `database` (Postgres) — all durable state, including the `run_jobs` queue.
- **Operational crons** — three `cron` services, each a `curl` POST to an authed gateway admin endpoint (the bearer key and gateway host are pulled from the gateway service via `fromService`):
  - **`<name>-retention`** — daily (`0 4 * * *`) → `POST /admin/retention` (two-domain retention cleanup).
  - **`<name>-schedules`** — every minute (`* * * * *`) → `POST /admin/schedules/tick`, the reconciler for the runtime-managed `schedules` table (created via `POST /schedules`) — a runtime tick, **not** a Render-native cron trigger. Optional: omit it if you only trigger via webhooks / the HTTP API and don't use the schedule store.
  - **`<name>-reaper`** — every 5 minutes (`*/5 * * * *`) → `POST /admin/runs/reap` (stranded-run reaper; Lane A roots only, see [Retention](#retention)).
- **Private services** (optional) — MCP servers, custom tool backends. Not emitted by the scaffolder.

**Entrypoints** — the scaffolder generates one entrypoint per service; each maps to a `package.json` script:

| Entrypoint | Service | Command |
|---|---|---|
| `src/server.ts` | gateway (web) | `npm run start` |
| `src/worker.ts` | chat worker (Lane B) | `npm run worker` |
| `src/workflows.ts` | workflows host (Lane A) | `npm run workflows` |

The generated `src/workflows.ts` host registers the plan-tiered tasks against `@renderinc/sdk/workflows` (`task()` per `workflow@<plan>` / `agent@<plan>`, bound to `workflowTaskHandler` / `agentTaskHandler`), matching `examples/demo`. Deployed on Render the SDK auto-starts the task server when `RENDER_SDK_SOCKET_PATH` is set; with no Render runtime the process idles (keep-alive) so the in-process Docker demo still boots.

Generated projects **run from source via `tsx`** in both dev and production (agents/skills are markdown, not compiled), so the project root stays the convention-discovery root. The `build` script is `tsc --noEmit` — a typecheck only, emitting no JS.[^build]

[^build]: The scaffolder's `render.yaml` hardcodes `buildCommand: npm install && npm run build` (and `startCommand: npm run …`) on every service regardless of the package manager chosen during scaffolding — see `packages/create-render-agents/src/blueprint.ts:475`.

### Local development

The scaffolder also emits a Docker stack for local runs. By default only the **gateway** comes up (`docker-compose.yaml` → Postgres + gateway); the gateway drives chat turns **in-process** locally (no queue mode, no separate worker). The warm chat worker is opt-in behind a Compose profile:

```sh
docker compose -f docker-compose.yaml up --build            # postgres + gateway (chat in-process)
docker compose -f docker-compose.yaml --profile worker up    # + the chat-worker (mirrors the prod split)
```

Locally, Lane A (workflows) also runs in-process — the durable dispatcher falls back to driving the workflow in the calling process, and the workflows host container just idles. This is the local-dev convenience path, not the real Render Workflows runtime. See the [operator deployment guide](../deployment.md) for the full env table and the hybrid "real Render Workflows locally" flow.

---

## Configuration

**Purpose** — There is no project-level config file. Each concern has its own home, so nothing duplicates what is already expressed in markdown frontmatter, `package.json`, or environment variables.

**Model** — Non-secret concerns live in their conventional home: agent defaults (model, budget, permissions) in `agents/_shared.md` frontmatter, project metadata in `package.json`, deploy topology in `render.yaml`, hooks auto-discovered from `hooks/`. Everything operational is an environment variable:

| Var | Purpose | Read by / notes |
|---|---|---|
| `DATABASE_URL` | Postgres vs in-memory store selection (also backs the `run_jobs` queue) | `createStore` / `createJobQueue` |
| `PORT` | Gateway listen port | `startGateway` |
| `RENDER_AGENTS_API_KEY` | Gateway bearer auth (constant-time) | `apiKeyAuth` |
| `RENDER_AGENTS_EXECUTION_MODE` | Root run/resume execution: `inline` (default) or `queue` | `createRuntime` |
| `RENDER_AGENTS_STRICT_APPROVAL` | Require human approval for gated tools | run context |
| `RENDER_AGENTS_ENCRYPTION_KEY` | AES-256-GCM key for OAuth tokens at rest + HMAC state | store crypto / OAuth routes |
| `RENDER_AGENTS_EVENT_RETENTION_DAYS` | Event-detail horizon (default 30) | `runRetention` |
| `RENDER_AGENTS_RUN_RETENTION_DAYS` | Run-summary horizon (default 90) | `runRetention` |
| `RENDER_AGENTS_RUN_STALE_MS` | Stranded-run horizon: a Lane A root silent this long is failed by the reaper (default 900000 = 15m) | `reapRuns` |
| `RENDER_SDK_SOCKET_PATH` / `RENDER_USE_LOCAL_DEV` | In-container Render signal: child `agent.task()` chaining via `runTask` | `isWorkflowsEnvironment` |
| `RENDER_API_KEY` + `RENDER_WORKFLOW_SLUG` | Gateway root-trigger signal: select the Render dispatcher to `startTask` workflow roots (Lane A), even outside a Workflows container | `isRootTriggerEnvironment` |
| `RENDER_LOCAL_DEV_URL` | Local Render Workflows dev-server URL (hybrid local Lane A) | dispatcher |
| `GATEWAY_URL` | Cron→gateway wiring only (the crons `curl` `$GATEWAY_URL/admin/…`); **not read by the runtime** | `render.yaml` crons |
| `GATEWAY_ORIGIN` | UI dev-server proxy target only; **not read by the runtime** | `vite.ui.config.ts` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / an agent's `apiKeyEnv` | Provider credentials (engine model-client resolution) | model clients |

**Naming convention.** SDK-owned settings use the `RENDER_AGENTS_` prefix. Platform- and ecosystem-standard names keep their conventional form: `DATABASE_URL`, `PORT`, the Render-provided `RENDER_SDK_SOCKET_PATH` / `RENDER_USE_LOCAL_DEV`, the root-trigger pair `RENDER_API_KEY` / `RENDER_WORKFLOW_SLUG`, and provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or an agent's declared `apiKeyEnv`).

**Execution mode.** The default is `inline` (root runs/resumes drive in the calling process) unless `RENDER_AGENTS_EXECUTION_MODE=queue`. Inline is the local-dev / single-process mode; a deployment that runs a separate chat-worker **must set `queue` on the gateway**, otherwise the gateway drives chat turns in-process and the worker sits idle.

The scaffolder's `render.yaml` sets `RENDER_AGENTS_EXECUTION_MODE=queue` on the gateway service, so generated deploys enqueue chat roots/resumes to `run_jobs` and the `<name>-chat-worker` drains them — the gateway never runs a chat turn in-process.

**Strict approvals.** `RENDER_AGENTS_STRICT_APPROVAL` gates approval-required tools in **all** environments (not just local): when set truthy, a gated tool call prompts on the TTY if the process is interactive, otherwise it pauses for HITL (see [Execution → HITL pause & resume](02-execution.md#hitl-pause--resume)).

**Store, queue & dispatcher selection.** `DATABASE_URL` selects Postgres vs in-memory for **both** the store and the `run_jobs` queue — the queue follows the store backend (sharing its connection pool), not an independent `DATABASE_URL` read. The Render Workflows dispatcher is selected when **either** an in-container socket (`RENDER_SDK_SOCKET_PATH` / `RENDER_USE_LOCAL_DEV`, for child `agent.task()` chaining inside the Workflows host) **or** the gateway root-trigger config (`RENDER_API_KEY` + `RENDER_WORKFLOW_SLUG`, for triggering workflow *roots* via `startTask`) is present; otherwise the in-process fallback runs (see [Execution → Runtime & composition](02-execution.md#runtime--composition)). When `RENDER_API_KEY` is present but `RENDER_WORKFLOW_SLUG` is omitted, the slug defaults to `"default"`.

The scaffolder's gateway env sets `RENDER_WORKFLOW_SLUG` (the `<name>-workflows` service) and `RENDER_API_KEY` (`sync: false`). The dispatcher auto-selects Render Workflows only when **both** are present, so leaving the key empty is a safe default: the gateway drives Lane A roots in-process until an operator pastes a Render API token, then hands off to the workflows host (which receives its in-container `RENDER_SDK_SOCKET_PATH` from Render at runtime). `@renderinc/sdk` is a generated dependency so the dispatcher resolves it at runtime.

**Auth surface.** The gateway accepts the API key as a `Bearer` header, or — for `EventSource`/SSE, which can't set request headers — a `?key=` query parameter. Auth is **fail-closed**: if the server-side `RENDER_AGENTS_API_KEY` is unset the gateway returns `500` (misconfigured), and a missing/invalid client key returns `401` (see `packages/gateway/src/auth.ts:9`).

**Encryption key fallback.** If `RENDER_AGENTS_ENCRYPTION_KEY` is unset, the gateway logs a startup warning and falls back to an insecure, hardcoded dev key for OAuth-token encryption — usable for local dev only. Production **must** set an explicit strong (32+ char) secret (see `packages/store/src/crypto.ts:38`).

**Scaffolder baseline vs production.** The generated `.env.example` covers the gateway/provider/retention baseline (`PORT`, `RENDER_AGENTS_API_KEY`, `RENDER_AGENTS_ENCRYPTION_KEY`, `DATABASE_URL`, `RENDER_AGENTS_STRICT_APPROVAL`, the retention days, and the provider key). The generated `render.yaml` already wires the lane-separation vars on the gateway (`RENDER_AGENTS_EXECUTION_MODE=queue`, `RENDER_WORKFLOW_SLUG`, and a `sync: false` `RENDER_API_KEY`); the operator only needs to paste a Render API token to promote Lane A from in-process to the Render Workflows host.

---

## Retention

**Purpose** — Data grows at different rates and serves different operational needs. Retention is therefore split into two domains: short-horizon **event detail** and longer-horizon **run summaries**, while preserving user/thread data.

**Model** — Default retention:

- **Event-detail domain** (high volume): `run_events` and event-derived detail projections (`spans`, `run_messages`, `tool_calls`, `workflow_steps`, `approval_requests`) are retained for 30 days, configurable via `RENDER_AGENTS_EVENT_RETENTION_DAYS`
- **Run-summary domain** (lower volume): `runs` is retained for 90 days, configurable via `RENDER_AGENTS_RUN_RETENTION_DAYS`
- Threads + their `messages` transcript: no automatic expiry (user data). The `messages` projection is the human-facing chat history, so it is kept with the thread even though it folds from `message.*` events — unlike the per-agent `run_messages`, which is event-detail and trimmed at the event horizon.
- Schedules: no automatic expiry (configuration data)

Event-detail trimming removes `run_events` and detail projections in the same pass. Those projections are rebuildable only within the retained event horizon.

`runs` may intentionally outlive event detail to preserve list/history/status/cost reporting for longer windows at lower storage cost. Tradeoff: once detailed events expire, full trace/message/tool replay is no longer reconstructable for those older runs.

Recommended production baseline: keep `RENDER_AGENTS_RUN_RETENTION_DAYS > RENDER_AGENTS_EVENT_RETENTION_DAYS` (default 90 > 30) so operational history outlives high-volume detail.

If strict replayability is required for the full run lifetime, set `RENDER_AGENTS_RUN_RETENTION_DAYS <= RENDER_AGENTS_EVENT_RETENTION_DAYS` (or set both equal).

Invalid or empty values for either retention env var fall back to the defaults (30 / 90).

**Cleanup is external, not an in-gateway timer.** The two-domain cleanup runs when something POSTs to the gateway's authed `POST /admin/retention` (bearer key). In production this is driven by the daily `<name>-retention` Render Cron; there is no background timer inside the gateway process.

**Stranded-run reaper.** A second, separate cleanup guards Lane A liveness. When the workflows host accepts a root trigger but never progresses it (container dies, task lost), no terminal event ever arrives and the run would sit `running` forever. The reaper fails non-terminal Lane A roots that have **no active `run_jobs` job** (Lane B chat turns are reclaimed by the job queue's own reaper, not failed here) and whose most recent event is older than `RENDER_AGENTS_RUN_STALE_MS` (default 15m — a workflow that keeps emitting events resets the clock). It runs via the authed `POST /admin/runs/reap` endpoint, driven by the every-5-minutes `<name>-reaper` Render Cron.

---

## Operational endpoints

**Purpose** — The gateway exposes a small set of authed `/admin/*` endpoints that back the operational crons and the operator UI. All require the bearer key; the crons `curl` them on a schedule.

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/admin/retention` | Two-domain retention cleanup (event-detail + run-summary); daily cron. |
| `POST` | `/admin/runs/reap` | Stranded-run reaper — fails silent Lane A roots; every-5-minutes cron. |
| `POST` | `/admin/schedules/tick` | Runtime-managed schedule reconciler — fires due `schedules`-table entries; per-minute cron. |
| `GET` | `/admin/jobs` | Chat-lane (`run_jobs`) queue depth — job counts by status + backlog, for observability. |

---

## Non-functional requirements

**Purpose** — The targets the SDK is held to across runtime, build, and operational dimensions.

**Model:**

| Requirement | Target |
|---|---|
| Node version | 20+ |
| Module system | ESM only |
| TypeScript | Strict mode + declaration emit for the published `@render-agents/*` packages; generated projects are typecheck-only (`tsc --noEmit`, no `.d.ts` emit) since they run from source via `tsx` |
| Local dev without Postgres | In-memory store with equivalent loop semantics; no durable checkpoint/resume across process restarts |
| Agent load + validation | Design target < 500ms for 20 agents; CI gate is 1500ms (3× margin) |
| LLM loop overhead per turn | Design target < 10ms (excluding model latency); CI gate is 30ms |
| Event append latency | < 5ms (append + projection update, non-blocking) — a **memory-store** benchmark; the Postgres path is not latency-gated in CI |
| SSE delivery latency | Design target < 100ms from event append to client; no automated CI gate |
| Zero external dependencies for observability | Postgres is sufficient |
| Package size (`@render-agents/sdk`) | < 100KB minified |
