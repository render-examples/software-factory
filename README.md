# render-factory

An open-source, self-hosted platform and framework for building autonomous coding agent workflows that run on Render.

## What is render-factory?

You define agents in markdown, wire them into durable multi-step workflows, and deploy them to Render. They receive work from Slack and GitHub, execute code in sandboxes, and deliver results back to those surfaces automatically.

A GitHub issue comes in → the agent triages it, researches the codebase, plans a change, implements it in an isolated sandbox, and opens a pull request. A PR is opened → the agent fans out specialized reviewers (security, performance, correctness, tests), aggregates their findings, and posts a GitHub review. Someone asks for a fix in a PR comment → the agent applies it and pushes to the branch.

## Who is this for?

- **Teams that want self-hosted coding agent embedded in their existing workflow.** The agent meets you where you already are instead of requiring a new tool or UI.
- **Platform teams building internal developer tools.** render-factory is a framework, not a product. You own the agents, workflows, tools, and deployment. Fork it and customize the behavior for your codebase and process.
- **Anyone outgrowing one-shot CLI agents.** If you've been using Claude Code, Codex, or similar tools and want an agent that persists across sessions, handles multi-step work durably, runs in CI-like isolation, and integrates with your team's channels: this is the next step.

## Why not just use Claude Code / Cursor / Codex?

Those tools are great for interactive, developer-in-the-loop coding. render-factory solves a different problem:

| | CLI/IDE agents | render-factory |
|---|---|---|
| **Runs where?** | Your laptop, your terminal session | Always-on cloud service on Render |
| **Triggered by** | You typing a prompt | Slack messages, GitHub issues/PRs, HTTP API |
| **Execution model** | Single session, lost if you close the terminal | Durable workflows with event-sourced replay — survives crashes and restarts |
| **Code execution** | Your local filesystem | Isolated Render Sandboxes — no risk to your machine or production code |
| **Multi-step work** | You manually chain prompts | Orchestrated pipelines: research -> plan -> implement -> PR, or fan-out 4 reviewers -> judge |
| **Team visibility** | Only you see it | Results posted to Slack threads, GitHub PR reviews — the whole team sees the work |
| **Human-in-the-loop** | Always (you're driving) | Selective: deploys require approval, code changes get PR review, everything else runs autonomously |
| **Cost control** | Per-session token limits | Per-agent budgets (max iterations, max USD, wall-clock timeout) baked into agent definitions |

In short: CLI agents are a power tool for one developer. render-factory is infrastructure for a team's autonomous coding agents that work in the background, durably, across your existing surfaces.

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
