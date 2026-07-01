# Deployment, configuration & retention

How a render-agents project runs in production. The canonical manifest is the
`render.yaml` emitted by `create-render-agents` (Sprint 21); this document is the
operator reference for it. See the normative [Operations](specs/04-operations.md) spec.

## Topology

A deployment is a small set of Render primitives wired by one `render.yaml`:

| Service | Type | Role |
|---|---|---|
| `<app>-gateway` | `web` (Hono) | Webhook/HTTP/chat ingress, SSE, HITL, OAuth, `/ui`; triggers both lanes |
| `<app>-chat-worker` | `worker` | **Lane B (chat):** warm, long-lived; drains the Postgres `run_jobs` queue and drives interactive turns + HITL resumes in-process |
| `<app>-workflows` | `worker` | **Lane A (durable):** Render Workflows host — registers `workflow@<plan>` + `agent@<plan>` task handlers; Render provisions isolated, scale-to-zero containers per run and is the durable queue |
| `<app>-db` | `database` | Postgres — the event log + all projections + the chat `run_jobs` queue |
| `<app>-retention` | `cron` | Daily `POST /admin/retention` cleanup |
| `<app>-reaper` | `cron` | Periodic `POST /admin/runs/reap` — fails Lane A roots stranded by an unreachable workflows host |

Two execution lanes (D12), one trigger surface. The gateway records `run.started`
then routes: durable pipelines fan out to Render Workflows (`dispatchRoot` →
`startTask`, fire-and-forget), while interactive chat turns are enqueued as
`agent` jobs that the warm chat worker drives. HITL resume mirrors the lanes —
a workflow root re-triggers + replays; a chat turn enqueues a durable `resume`
job. All services call `createRuntime()` identically (one composition root) and
`RunStore.init()` on boot (advisory-locked migrations — safe under concurrent start).

## Configuration contract (environment variables)

There is **no project-level config file**. Each concern has a home: agent
config in markdown frontmatter, project metadata in `package.json`, deploy in
`render.yaml`, secrets/infra in env vars.

| Var | Purpose | Honored by |
|---|---|---|
| `DATABASE_URL` | Postgres vs in-memory store selection | `createStore` |
| `PORT` | Gateway listen port | `startGateway` |
| `RENDER_AGENTS_API_KEY` | Gateway bearer auth (constant-time) | `apiKeyAuth` |
| `RENDER_AGENTS_STRICT_APPROVAL` | Require human approval for gated tools | run context |
| `RENDER_AGENTS_ENCRYPTION_KEY` | AES-256-GCM key for OAuth tokens at rest + HMAC state | store crypto / OAuth routes |
| `RENDER_SDK_SOCKET_PATH` / `RENDER_USE_LOCAL_DEV` | In-container signal: child `agent.task()` chaining via `runTask` | `isWorkflowsEnvironment` |
| `RENDER_API_KEY` + `RENDER_WORKFLOW_SLUG` | Gateway root-trigger signal: select the Render dispatcher to `startTask` workflow roots (Lane A), even outside a Workflows container | `isRootTriggerEnvironment` |
| `RENDER_WORKFLOW_SLUG` | Workflow slug for task dispatch (`<slug>/workflow@<plan>`) | runtime / dispatcher |
| `RENDER_AGENTS_EVENT_RETENTION_DAYS` | Event-detail horizon (default 30) | `runRetention` |
| `RENDER_AGENTS_RUN_RETENTION_DAYS` | Run-summary horizon (default 90) | `runRetention` |
| `RENDER_AGENTS_RUN_STALE_MS` | Stranded-run horizon: a Lane A root silent this long is failed by the reaper (default 900000 = 15m) | `reapRuns` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Provider credentials | model clients |

> The gateway warns at startup if `RENDER_AGENTS_ENCRYPTION_KEY` is unset (OAuth
> tokens would use an insecure dev key). `render.yaml` uses `generateValue: true`
> for the API key + encryption key so they're provisioned automatically.

## Retention

Storage growth is bounded by a **two-domain** cleanup (`runRetention` →
`RunStore.cleanup`), run daily via the cron service (or any scheduler hitting
`POST /admin/retention`):

- **Event-detail** (`run_events` + `spans`/`run_messages`/`tool_calls`/`workflow_steps`/`approval_requests`):
  trimmed for **terminal** runs older than `RENDER_AGENTS_EVENT_RETENTION_DAYS` (30).
- **Run-summary** (`runs`): deleted for terminal runs older than `RENDER_AGENTS_RUN_RETENTION_DAYS` (90).
- **Never trimmed:** non-terminal runs (running/paused/pending) regardless of age;
  thread metadata + the human-facing `messages` transcript; schedules.

Keep `RUN_RETENTION_DAYS > EVENT_RETENTION_DAYS` so operational history (list/cost/status)
outlives high-volume detail. Tradeoff: once event-detail expires, full trace/message/tool
replay is no longer reconstructable for those runs. For strict replayability, set them equal.

## Reliability: cancellation, fail-fast dispatch & the run reaper

Three mechanisms keep runs from getting stuck or running past a cancel:

- **Cancellation cascades down the run tree (cooperative).** `POST /runs/:id/cancel`
  flags the run in the cancel store. Every run carries a *cancel scope* — the id of
  its root — so a descendant agent run (Lane A child task or in-process subagent)
  trips its cancel check when **either** its own id or its scope is cancelled. A
  workflow handler also polls the scope at each `ctx.step` / `agent.task()` boundary
  and unwinds (recording a terminal `run.cancelled` instead of overwriting it with
  `run.completed`). Because the check reads the shared store, the cascade works
  across Lane A task containers. *Cooperative* means a run mid-LLM-call finishes that
  call before exiting at its next loop boundary — cancel is prompt, not instantaneous.
- **Fail-fast on a failed hand-off.** `run.started` is recorded before Lane A is
  triggered. If `dispatchRoot` (→ `startTask`) throws — e.g. the workflows host is
  unreachable — `workflow.dispatch` records `run.failed` immediately so the run is
  terminal and the caller sees the failure rather than a stuck `running`.
- **The run reaper backstops silent strandings.** If the host *accepts* the trigger
  but never progresses it (container dies, task lost), no terminal event ever
  arrives. The reaper (`reapRuns` → `RunStore.reapStaleRuns`, via a periodic
  `POST /admin/runs/reap` cron) fails Lane A roots that are non-terminal, have **no
  active queue job** (Lane B is reclaimed by the job queue's own reaper, not failed),
  and whose most recent event is older than `RENDER_AGENTS_RUN_STALE_MS` (15m). A
  workflow that keeps emitting events resets the clock, so only genuinely stranded
  roots are reaped.

The matching thread-safety guard: at most one active run per thread is enforced by a
partial unique index (`idx_runs_thread_active`). A race that slips past the soft check
raises a unique violation on the second `run.started`, which both the workflow and
chat-agent thread paths translate into a clean `409` (thread busy), never a 500.

## Local development

The repo ships a full local stack (`docker-compose.yaml` + `Dockerfile`) that
builds every package into one image and runs the topology against Postgres via
the `examples/demo` app (gateway + chat-worker + workflows host):

```sh
cp .env.example .env          # add a provider key (ANTHROPIC_API_KEY / OPENAI_API_KEY)
docker compose up --build     # postgres + gateway + chat-worker + workflows
# operator UI → http://localhost:3000/ui  (API key: RENDER_AGENTS_API_KEY, default dev-key)
```

Prefer running on the host? Bring up just Postgres and run the app with hot reload:

```sh
pnpm install && pnpm build
docker compose up -d postgres
DATABASE_URL=postgres://postgres:postgres@localhost:5432/agents \
RENDER_AGENTS_API_KEY=dev-key \
pnpm --filter @render-agents/example-demo dev   # gateway on :PORT, in-memory if DATABASE_URL unset
```

In-memory mode (no `DATABASE_URL`) has equivalent loop semantics but no durable
resume across restarts.

In both of the above, Lane A (workflows) runs **in-process** — the durable lane's
dispatcher falls back to driving the workflow in the calling process (the
workflows host container just idles). This is the local-dev convenience fallback,
not the real Render Workflows runtime.

### Exercising the real Render Workflows runtime locally

To run Lane A through the actual durable dispatch path, use the Render Workflows
[local task server](https://render.com/docs/workflows-local-development) (Render
CLI required). The workflows host registers `workflow@<plan>` + `agent@<plan>`
tasks under `render workflows dev`, and the gateway/worker set
`RENDER_USE_LOCAL_DEV=true` so `createRuntime` selects the
`RenderWorkflowsDispatcher`, which triggers `runTask`/`startTask` against the
local server (`:8120`). All processes share the Dockerized Postgres. See
[`examples/demo/README.md`](../examples/demo/README.md#hybrid-local-dev-real-render-workflows-runtime-lane-a)
for the step-by-step flow. Key points:

- Task identifiers are `"$RENDER_WORKFLOW_SLUG/<task>@<plan>"`.
- The local server keeps run state in memory (no Valkey required — that's only
  for the SDK's experimental Key Value API), and ignores the API key, though the
  `@renderinc/sdk` client still requires a placeholder token (supplied by the
  dispatcher in local-dev).

## Health & scaling

- Health check: `GET /health` (no auth).
- The gateway is stateless (all state in Postgres) → scale horizontally.
- The workflow service scales independently; compute tier is bound per `agent@<plan>` task.
