# render-factory

A framework for building AI coding agents on Render. Markdown-first agent authoring, durable workflow orchestration, sandboxed code execution, and multi-channel delivery (Slack, GitHub).

---

## Architecture

Two services, one Postgres database:

```
Triggers (Slack / GitHub webhooks / HTTP API)
                    |
                 Gateway
       (auth, webhooks, thread management)
                    |
            Render Workflows
   (chat turns, spec-to-pr, pr-review, pr-fix)
                    |
              Postgres Store
    run_events (canonical log) + projections
    thread_items + thread_surfaces
```

- **Gateway** — thin HTTP front door. Verifies webhooks, creates threads/surfaces, dispatches workflow tasks. No agent execution.
- **Workflows Host** — runs all agent compute. Chat turns, multi-step pipelines (spec-to-pr), code reviews. Uses Render Sandboxes for isolated code execution.

### Data Model

| Entity | Purpose |
|--------|---------|
| **Thread** | Persistent conversation. Owns surfaces and items. |
| **ThreadSurface** | Where to deliver notifications (Slack channel:ts, GitHub issue). |
| **ThreadItem** | User-facing timeline: messages, workflow results, status updates. |
| **Run** | Unit of execution on a thread. Interactive (chat turn) or background (spec-to-pr). |
| **RunEvent** | Internal append-only log per run. |

Workflows dispatched from a conversation inherit the thread. When they complete, results are appended as thread items and all surfaces are notified automatically.

---

## Project Structure

```
render-factory/
├── packages/                  # Reusable libraries
│   ├── engine/                # Agent loop, tools, model clients, context
│   ├── sdk/                   # Runtime, workflows, dispatch, loading
│   ├── store/                 # Event log, projections, surfaces, items
│   ├── gateway/               # HTTP service, auth, routes, SSE, operator UI
│   └── sandbox/render/        # Render Sandbox provider
├── app/                       # Deployable application
│   ├── agents/                # Agent definitions (.md)
│   ├── tools/                 # sandbox, deploy, start_workflow
│   ├── channels/              # slack.ts, github.ts
│   ├── workflows/             # chat-turn, spec-to-pr, pr-review, pr-fix
│   └── src/                   # server.ts (gateway), workflows.ts (host)
├── Dockerfile
├── docker-compose.yaml
└── render.yaml                # Render Blueprint
```

---

## Agents

Agents are markdown files in `app/agents/`:

```md
---
description: Implements the plan, edits files, and runs tests
tools: [sandbox]
budget:
  maxIterations: 60
  maxCostUsd: 15
---

You are the Implement phase of a Research -> Plan -> Implement loop.
Your input provides sandbox_id and repoDir...
```

Current agents: `assistant`, `triage`, `researcher`, `planner`, `implementer`, `security`, `performance`, `correctness`, `tests`, `judge`, `deployer`, `lint`.

---

## Workflows

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `chat-turn` | Slack message / API thread | Drives one interactive agent turn, posts reply |
| `spec-to-pr` | `start_workflow` tool | Triage, research, plan, implement in a sandbox, open PR |
| `pr-review` | GitHub `pull_request` webhook | Fan-out 4 reviewers, judge, post GitHub review |
| `pr-fix` | GitHub PR comment | Apply fixes in sandbox, push to branch |

The `assistant` agent can trigger `spec-to-pr` via the `start_workflow` tool. The workflow runs on the same thread, so results are posted back to the originating Slack conversation automatically.

---

## Tools

| Tool | Description |
|------|-------------|
| `sandbox` | Exec, read, write, search in Render Sandboxes (explicit `sandbox_id` per call) |
| `start_workflow` | Dispatch a background workflow from a chat conversation |
| `deploy` | Deploy to an environment (approval-gated) |

---

## Local Development

```sh
# Prerequisites: Node 22+, pnpm, Docker, Render CLI

# 1. Install
pnpm install
pnpm build

# 2. Start Postgres
docker compose up -d postgres

# 3. Start workflows host (terminal 1)
cd app && source ../.env && render workflows dev -- tsx src/workflows.ts

# 4. Start gateway (terminal 2)
cd app && source ../.env && RENDER_USE_LOCAL_DEV=true PORT=3010 tsx src/server.ts

# 5. Test
curl -X POST localhost:3010/threads \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" -d '{}'
```

---

## Deploy to Render

The gateway deploys via the `render.yaml` Blueprint (Docker). The Workflows service is created manually in the Dashboard:

- **Gateway**: Docker, `render.yaml` Blueprint handles it
- **Workflows**: Docker (same Dockerfile), start command: `node app/dist/src/workflows.js`
- **Postgres**: Managed, provisioned by Blueprint

Required env vars: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `RENDER_API_KEY`, `RENDER_WORKFLOW_SLUG`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `GITHUB_TOKEN`.

---

## Contributing

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Node 22+, ESM-only, strict TypeScript, pnpm workspace.
