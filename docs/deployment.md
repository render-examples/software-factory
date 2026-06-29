# Deployment, configuration & retention

How a render-agents project runs in production. The canonical manifest is the
`render.yaml` emitted by `create-render-agents` (Sprint 21); this document is the
operator reference for it. See the normative [Operations](specs/04-operations.md) spec.

## Topology

A deployment is a small set of Render primitives wired by one `render.yaml`:

| Service | Type | Role |
|---|---|---|
| `<app>-gateway` | `web` (Hono) | Webhook/HTTP/chat ingress, SSE, HITL, OAuth, `/ui` |
| `<app>-workflows` | `worker` | Workflow service: registers `agent@<plan>` tasks + workflow roots |
| `<app>-db` | `database` | Postgres — the event log + all projections |
| `<app>-retention` | `cron` | Daily `POST /admin/retention` cleanup |

Both services call `createRuntime()` identically (one composition root) and
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
| `RENDER_SDK_SOCKET_PATH` / `RENDER_USE_LOCAL_DEV` | Select the Render Workflows dispatcher vs in-process fallback | `isWorkflowsEnvironment` |
| `RENDER_WORKFLOW_SLUG` | Workflow slug for task dispatch | runtime |
| `RENDER_AGENTS_EVENT_RETENTION_DAYS` | Event-detail horizon (default 30) | `runRetention` |
| `RENDER_AGENTS_RUN_RETENTION_DAYS` | Run-summary horizon (default 90) | `runRetention` |
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

## Local development

```sh
docker compose up -d          # local Postgres (compose.yaml), optional
cp .env.example .env          # add provider key + RENDER_AGENTS_API_KEY
pnpm dev                      # gateway on :PORT, in-memory if DATABASE_URL unset
```

In-memory mode has equivalent loop semantics but no durable resume across restarts.

## Health & scaling

- Health check: `GET /health` (no auth).
- The gateway is stateless (all state in Postgres) → scale horizontally.
- The workflow service scales independently; compute tier is bound per `agent@<plan>` task.
