# @render-agents/example-demo

A runnable demo that wires the monorepo packages (`engine` → `store` → `sdk` →
`gateway`) into the canonical two-lane topology:

- `src/server.ts` — gateway (web): front door + SSE, triggers both lanes
- `src/worker.ts` — chat worker (Lane B): drains the Postgres `run_jobs` queue
- `src/workflows.ts` — workflows host (Lane A): loads the durable pipeline image

The default example is a **code-review** pipeline (security + performance
reviewers → judge) plus a conversational `assistant` for chat threads.

## Run it (Docker, from the repo root)

```sh
cp .env.example .env          # add ANTHROPIC_API_KEY or OPENAI_API_KEY to run agents
docker compose up --build     # postgres + gateway + chat-worker + workflows host
# operator UI → http://localhost:3000/ui  (API key: RENDER_AGENTS_API_KEY, default dev-key)
```

Dispatch a run:

```sh
curl -X POST localhost:3000/workflows/code-review \
  -H "Authorization: Bearer ${RENDER_AGENTS_API_KEY:-dev-key}" \
  -H "Content-Type: application/json" \
  -d '{"input":{"diff":"--- a/app.ts\n+++ b/app.ts"}}'
```

The stack boots without a provider key (health + UI work); actually running an
agent requires `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

In the default Docker stack, Lane A (workflows) runs **in-process** inside the
gateway container — the workflows host container just validates the image loads
and idles. That's the local-dev convenience fallback, not the real Render
Workflows runtime. To exercise the actual durable lane, use the hybrid flow
below.

## Run on the host instead

```sh
pnpm install && pnpm build                          # build the workspace packages
docker compose up -d postgres                        # just Postgres
DATABASE_URL=postgres://postgres:postgres@localhost:5433/agents \
RENDER_AGENTS_API_KEY=dev-key \
pnpm --filter @render-agents/example-demo dev        # gateway with hot reload
```

## Hybrid local-dev: real Render Workflows runtime (Lane A)

This routes workflow **roots** and `agent.task()` **children** through the
[Render Workflows local task server](https://render.com/docs/workflows-local-development)
instead of running them in-process — the same dispatch path as production, just
against a local in-memory task server. Requires the [Render CLI](https://render.com/docs/cli)
(`render`) on your PATH.

How it fits together:

- `src/workflows.ts` registers one Render task per referenced plan tier —
  `workflow@<plan>` (bound to `workflowTaskHandler`) and `agent@<plan>` (bound to
  `agentTaskHandler`). The Render CLI runs it as a local task server on `:8120`.
- The gateway/worker set `RENDER_USE_LOCAL_DEV=true`, so `createRuntime` selects
  the `RenderWorkflowsDispatcher`, which triggers `runTask`/`startTask` against
  that local server. Task identifiers are `"$RENDER_WORKFLOW_SLUG/<task>@<plan>"`.
- All processes share the Dockerized Postgres, so events/projections line up.

Config lives in `.env` (provider key) + `.env.localdev` (non-secret: `DATABASE_URL`,
`RENDER_USE_LOCAL_DEV`, `RENDER_LOCAL_DEV_URL`, `RENDER_WORKFLOW_SLUG`).

```sh
# 0. one-time: provider key + local-dev config
cp .env.example .env          # add ANTHROPIC_API_KEY or OPENAI_API_KEY
# .env.localdev is committed-as-ignored; create it (see template in this dir) with:
#   DATABASE_URL=postgres://postgres:postgres@localhost:5433/agents
#   RENDER_USE_LOCAL_DEV=true
#   RENDER_LOCAL_DEV_URL=http://localhost:8120
#   RENDER_WORKFLOW_SLUG=local
#   RENDER_AGENTS_API_KEY=dev-key

pnpm install && pnpm build
docker compose up -d postgres                         # shared Postgres on :5433

# 1. terminal A — workflows host under the Render local task server (port 8120):
pnpm --filter @render-agents/example-demo dev:workflows
#   (== `render workflows dev --env-file .env --env-file .env.localdev -- pnpm exec tsx src/workflows.ts`)

# 2. terminal B — gateway in local-dev mode:
cd examples/demo
set -a; . ./.env; . ./.env.localdev; set +a
PORT=3010 pnpm exec tsx src/server.ts

# 3. terminal C — dispatch a workflow (runs via the local task server):
curl -X POST localhost:3010/workflows/code-review \
  -H "Authorization: Bearer dev-key" -H "Content-Type: application/json" \
  -d '{"input":{"diff":"--- a/q.ts\n+++ b/q.ts\n+ const q = `SELECT * FROM t WHERE id=${id}`"}}'
curl localhost:3010/runs/<id> -H "Authorization: Bearer dev-key"   # poll → completed
```

In terminal A you'll see the chained tasks fire, e.g.:

```
Task running: trn-… (workflow@standard) input=[{"workflow":"code-review","runId":"…"}]
Task running: trn-… (agent@standard)    input=[{"agentName":"security",…}]
Task running: trn-… (agent@standard)    input=[{"agentName":"performance",…}]
```

Notes:
- The Render CLI does a direct `fork/exec`, so the start command must resolve on
  PATH — hence `pnpm exec tsx …` rather than bare `tsx …`.
- The local task server keeps run state **in memory** (no Valkey needed — that's
  only for the SDK's experimental Key Value API). Restart it to clear state.
- The local task server **ignores the API key**, but `@renderinc/sdk`'s client
  still requires *some* token; the dispatcher passes a placeholder in local-dev.
