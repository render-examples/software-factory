# @render-agents/gateway

The deployable web service for [render-agents](../../README.md): a [Hono](https://hono.dev)
app exposing runs, streaming, HITL, OAuth, webhooks, and a dev trace viewer.

```ts
import { startGateway } from "@render-agents/gateway";
const { port } = await startGateway({ runtime, workflows, defaultWorkflow: "code-review" });
```

## Routes

- `POST /workflows/:name` — dispatch a run; `GET /runs`, `/runs/:id`, `/runs/:id/spans`, `/runs/:id/tool-calls`; `POST /runs/:id/cancel`.
- `GET /runs/:id/stream`, `/threads/:id/stream` — SSE live tail of the event log (resumable from `seq`).
- `GET/POST /threads…` — thread create/list/get + message delivery (sequential-turn enforced).
- `GET /approvals`, `POST /approvals/:id/resolve`, `POST /runs/:id/input` — HITL; resolving **resumes** the paused run.
- `GET /oauth/:provider/authorize|callback`, `DELETE /oauth/:provider` — OAuth connect/exchange/revoke (encrypted at rest).
- `POST /webhooks/:name`, `POST /connectors/:key` — trigger surfaces.
- `POST /admin/retention` — two-domain cleanup (wire to a daily cron).
- `GET /ui` — dependency-free dev trace viewer (run list, span tree, per-agent cost, live SSE).

Auth is API-key bearer (`RENDER_AGENTS_API_KEY`), with a `?key=` fallback for EventSource. `/health` and the `/ui` shell are unauthenticated.
