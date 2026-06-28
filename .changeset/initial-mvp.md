---
"@render-agents/sdk": minor
"@render-agents/engine": minor
"@render-agents/store": minor
"@render-agents/gateway": minor
"create-render-agent": minor
---

Initial MVP release: event-sourced markdown agents with in-process + Render Workflows
execution, Postgres/in-memory stores, HITL pause/resume, threads, OAuth (encrypted at
rest, single-flight refresh), hooks, a Hono gateway (runs/SSE/HITL/OAuth/webhooks), a
dev-mode trace viewer at `/ui`, two-domain retention, the `create-render-agent`
scaffolder, and NFR gates (sdk < 100KB, perf benches).
