# render-agents

Markdown-authored, event-sourced AI agents that run locally and deploy to Render
as a gateway + chat worker + Workflows host + Postgres — with the same code path everywhere.

- **Markdown is the agent.** Agents are `agents/*.md` files; behavior is the prompt, config is frontmatter.
- **Event-log-first.** An append-only `run_events` log is the single source of truth; runs, spans, messages, approvals, costs, and the SSE stream are all projections of it.
- **One execution model.** `agent.run()` (in-process) and `agent.task()` (durable, isolated via Render Workflows) are the same definition — just a different call site.
- **Two execution lanes.** Durable pipelines run on Render Workflows (queued, isolated, scale-to-zero); interactive chat runs one short run per turn on a warm worker fed by a Postgres `run_jobs` queue. The gateway only triggers and streams — it never runs an agent loop in production.
- **Observable by default.** Every unit is a span; Postgres is sufficient (no external collector). A built-in operator UI (runs, traces, live event stream, approvals, chat) ships at `/ui`.

## Quick start

```sh
npm create render-agents@latest my-agents
cd my-agents
npm install
cp .env.example .env      # add your ANTHROPIC_API_KEY / OPENAI_API_KEY + RENDER_AGENTS_API_KEY
npm run dev               # gateway on :3000, in-memory store
```

Dispatch the default code-review workflow:

```sh
curl -X POST localhost:3000/workflows/code-review \
  -H "Authorization: Bearer $RENDER_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":{"diff":"--- a/app.ts\n+++ b/app.ts"}}'
```

Open the operator UI at `http://localhost:3000/ui`.

## Packages

| Package | Role |
|---|---|
| [`@render-agents/sdk`](packages/sdk) | Public API: authoring, discovery, runtime composition, workflows |
| [`@render-agents/engine`](packages/engine) | The agent loop, tools, model clients, context management |
| [`@render-agents/store`](packages/store) | Event log + projections (in-memory + Postgres), threads, OAuth, retention |
| [`@render-agents/gateway`](packages/gateway) | Hono web service: runs, SSE, HITL, OAuth, webhooks, `/ui` |
| [`create-render-agents`](packages/create-render-agents) | `npm create render-agents` scaffolder |

## Documentation

- [Specification](docs/specs/00-foundations.md) — the layered technical contract (D1–D13).
- [Architecture](docs/architecture.md) — how the event-log-first design fits together.
- [Deployment, configuration & retention](docs/deployment.md).
- [Getting started](docs/getting-started.md) — scaffold → run → deploy.

## Development

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
pnpm check:bundle-size            # NFR gate: sdk < 100KB
# Postgres parity tests (optional locally; CI runs them):
TEST_DATABASE_URL=postgres://... pnpm --filter @render-agents/store test
```

Node 20+, ESM-only, strict TypeScript. The dependency graph is acyclic:
`store ← engine ← sdk`, with `gateway` depending on `sdk` + `store`.
