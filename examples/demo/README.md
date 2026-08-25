# @render-factory/example-demo

A runnable demo that wires the monorepo packages (`engine` → `store` → `sdk` →
`gateway`) into the canonical two-lane topology:

- `src/server.ts` — gateway (web): front door + SSE, triggers both lanes
- `src/worker.ts` — chat worker (Lane B): drains the Postgres `run_jobs` queue
- `src/workflows.ts` — workflows host (Lane A): loads the durable pipeline image

The default example is a **code-review** pipeline (security + performance
reviewers → judge) plus a conversational `assistant` for chat threads.

It also ships two **GitHub agent workflows** (see
[GitHub agent workflows](#github-agent-workflows-issue--pr--pr-review) below):
`issue-to-pr` (triage an issue → Research/Plan/Implement → open a PR) and
`pr-review` (multi-reviewer → judge → approve / request changes).

## Run it (Docker, from the repo root)

```sh
cp .env.example .env          # add ANTHROPIC_API_KEY or OPENAI_API_KEY to run agents
docker compose up --build     # postgres + gateway + chat-worker + workflows host
# operator UI → http://localhost:3000/ui  (API key: RENDER_FACTORY_API_KEY, default dev-key)
```

Dispatch a run:

```sh
curl -X POST localhost:3000/workflows/code-review \
  -H "Authorization: Bearer ${RENDER_FACTORY_API_KEY:-dev-key}" \
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
RENDER_FACTORY_API_KEY=dev-key \
pnpm --filter @render-factory/example-demo dev        # gateway with hot reload
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
#   RENDER_FACTORY_API_KEY=dev-key

pnpm install && pnpm build
docker compose up -d postgres                         # shared Postgres on :5433

# 1. terminal A — workflows host under the Render local task server (port 8120):
pnpm --filter @render-factory/example-demo dev:workflows
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

## GitHub agent workflows (issue → PR + PR review)

Two webhook-triggered pipelines, wired through a single adapter at
`POST /webhooks/github`:

- **`issue-to-pr`** (`issues`, `issue_comment`) — a `triage` agent decides if the
  issue has enough detail. If not, it posts the blocking questions as a comment
  and labels the issue `agent:needs-info`. Once there's enough (on open or after a
  human reply), it labels `agent:working`, clones the repo into an **ephemeral**
  per-run checkout, runs **Research → Plan → Implement** (three agents, in-process
  so they share one working copy), commits + pushes `agent/issue-<n>`, opens a PR,
  comments the link, and labels `agent:done`.
- **`pr-review`** (`pull_request`) — fans out to `security` + `performance` +
  `correctness` + `tests` reviewers in parallel, a `judge` produces a structured
  verdict, and the workflow submits a real GitHub review (**APPROVE** or
  **REQUEST_CHANGES**) with optional inline comments.

State is stored in **GitHub itself** (labels + the issue thread), so each webhook
delivery re-evaluates from scratch — there are no paused runs to correlate. The
`agent:working` / `agent:done` labels dedupe redundant deliveries, and events
authored by `GITHUB_BOT_LOGIN` are ignored (loop guard).

### Configure

```sh
# in .env (see repo-root .env.example)
GITHUB_TOKEN=            # fine-grained PAT: Contents RW, Pull requests RW, Issues RW
GITHUB_WEBHOOK_SECRET=   # shared secret set on the GitHub webhook
GITHUB_BOT_LOGIN=        # the PAT's account login (so the bot ignores its own events)
ANTHROPIC_API_KEY=       # (or OPENAI_API_KEY, with agents set to an OpenAI model)
```

On the target repo → **Settings → Webhooks → Add webhook**:
- **Payload URL:** `https://<your-gateway>/webhooks/github`
- **Content type:** `application/json`
- **Secret:** the same `GITHUB_WEBHOOK_SECRET`
- **Events:** Issues, Issue comments, Pull requests

Inbound webhooks are authenticated by the HMAC signature, not the operator API
key — the gateway exempts `/webhooks/*` from bearer auth by design.

### Filesystem substrate

The coding agents get `workspace__{exec,read_file,write_file,apply_patch,list_dir}`
tools (`tools/workspace`) backed by `node:child_process`, confined to the run's
checkout under `RENDER_WORKSPACE_DIR` (a temp dir by default). This is a
trusted-repo demo substrate — swap in a real sandbox (MCP/E2B) for untrusted code.
The deploy image (repo-root `Dockerfile`) installs `git`; add the target repo's
toolchain there if the implementer must run non-Node test suites.

### Deploy to Render

Render **Blueprints can't create Workflow services** (Dashboard-only), so deploy
is two parts: the Blueprint provisions the gateway + Postgres + crons, and you
create the durable **Workflow service** (Lane A) by hand.

1. **Blueprint** — from the repo root `render.yaml`, create a Blueprint. It
   builds the repo-root `Dockerfile` (installs `git`) and provisions:
   - `render-factory-demo-gateway` (web) — webhook ingress + `/ui`
   - `render-factory-demo-db` (Postgres)
   - retention + reaper crons

2. **Gateway secrets** — set `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`,
   `GITHUB_BOT_LOGIN`, `ANTHROPIC_API_KEY`.

3. **Workflow service** — **New > Workflow** in the Dashboard, same repo,
   **Language = Docker**, Dockerfile `./Dockerfile`, **Start Command**
   `pnpm --filter @render-factory/example-demo workflows`. The slug is defined in
   code as `render-factory` (`WORKFLOW_SLUG` in `src/lib/render.ts`), so no
   `RENDER_WORKFLOW_SLUG` env var is needed — just make sure this service's slug
   matches. Env vars: same `DATABASE_URL` (the demo-db Internal URL) and same
   `RENDER_FACTORY_ENCRYPTION_KEY` as the gateway, plus `RENDER_API_KEY` (needed to
   `runTask` the reviewer fan-out), `GITHUB_TOKEN`, `GITHUB_BOT_LOGIN`,
   `ANTHROPIC_API_KEY`, `GIT_AUTHOR_NAME/EMAIL`. Deploying registers the
   `workflow@standard` / `agent@standard` tasks — confirm the slug before the `/`
   on its Tasks page equals `render-factory` (if it differs, update the constant or
   set `RENDER_WORKFLOW_SLUG`).

4. **Enable Lane A** — set `RENDER_API_KEY` (a Render API key, `rnd_…`) on **the
   gateway** (to `startTask` the root) — it's also on the Workflow service from
   step 3 (to `runTask` the fan-out). No slug env var: it's in code. Now the
   gateway dispatches workflows durably and acks webhooks instantly — required
   because the pipelines run longer than GitHub's ~10s webhook timeout.

5. **GitHub webhook** — point it at `https://<gateway>/webhooks/github`
   (see [Configure](#configure)).

The full click-by-click walkthrough is in the deployment instructions.
