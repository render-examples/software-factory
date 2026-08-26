# render-factory

An open-source, self-hosted fork-and-deploy template for building autonomous coding agent workflows that run on Render.

[Quickstart](#quickstart) · [Deploy](#deploy-to-render) · [Customize](#customize-your-factory) · [Architecture](#architecture)


## What it does

### Defining agents
You define agents in markdown, compose them as durable multi-step workflows, and deploy them to Render. The agents receive work from Slack and GitHub, execute code in sandboxes, and deliver results back to those surfaces automatically.

The template ships with four connected workflows:

- **Assistant (`chat-turn`)** — Slack message or API prompt → persistent thread → assistant response. After confirming the scope and target repository, the assistant can dispatch `spec-to-pr`.
- **Spec to PR (`spec-to-pr`)** — GitHub issue or assistant-approved spec → triage (for issues) → isolated sandbox → research → plan → implementation → best-effort tests → branch and pull request → originating surface notified.
- **PR review (`pr-review`)** — opened or updated non-draft PR → security, performance, correctness, tests, and lint reviewers fan out in parallel → judge agent combines their findings → one GitHub review.
- **PR fix (`pr-fix`)** — submitted review on an agent-created branch → branch reopened in a sandbox → implementer attempts follow-up changes → fixes pushed and the PR/thread notified.

## Who is this for?
- **Lean engineering teams** that want fully customizable background coding workflows without purchasing a closed agent control plane.
- **Teams that want self-hosted cloud coding agents embedded in their existing workflow.** The agent meets you where you already are instead of requiring a new tool or UI.
- **Platform-minded engineers** who want to customize agents, workflow stages, models, tools, and approval boundaries.
- **Anyone outgrowing one-shot CLI agents.** If you've been using Claude Code, Codex, or similar tools and want an agent that persists across sessions, handles multi-step work durably, runs in CI-like isolation, and integrates with your team's channels: this is the next step.

---

## Architecture

- **Gateway** — thin HTTP front door. Verifies webhooks, creates threads/surfaces, dispatches workflow tasks. No agent execution.
- **Workflows Host** — runs all agent compute. Chat turns, multi-step pipelines (spec-to-pr), code reviews. Agents use Render Sandboxes for isolated code execution.
- **Postgres** — event-sourced store. `run_events` (canonical append-only log) + projections (`thread_items`, `thread_surfaces`).


```text
Slack / GitHub / HTTP API
            │
            ▼
         Gateway
  authentication, webhooks,
  threads, streaming, operator UI
            │
            ▼
      Render Workflows
  chat turns, issue-to-PR,
  PR review, review follow-up
       │             │
       ▼             ▼
   Postgres     Render Sandboxes
 event log,      isolated code
 projections,      execution
 thread state
```

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

## What you customize
The deployable application lives in `app/`:
```text
app/
├── agents/       Markdown agent definitions
├── workflows/    Durable workflow orchestration
├── tools/        Sandbox, dispatch, and integration tools
├── channels/     Slack and GitHub webhook adapters
└── src/          Gateway and Workflows entrypoints
```


### Define an agent in Markdown

Agents live in `app/agents/`:
```md
---
description: Implements an approved plan and runs relevant tests
model: large
tools: [sandbox]
budget:
  maxIterations: 60
  maxCostUsd: 15
  maxWallSeconds: 1800
---
You are an...

```
Pre-built agents include: `assistant`, `triage`, `researcher`, `planner`, `implementer`, `security`, `performance`, `correctness`, `tests`, `judge`, `deployer`, `lint`.

---

### Compose agents into a workflow
```ts
import { workflow } from "@render-factory/sdk";
export default workflow({ name: "docs-refresh" }, async (ctx) => {
  const research = await ctx.agents
    .get("researcher")
    .run(ctx.input);
  const plan = await ctx.agents
    .get("planner")
    .run({ request: ctx.input, research: research.text });
  return ctx.agents
    .get("implementer")
    .task({ request: ctx.input, plan: plan.data ?? plan.text });
});
```
Use:
- `agent.run()` for an in-process child span
- `agent.task()` for an isolated durable child run
- `ctx.step()` for replay-safe side effects

---

## Pre-built Workflows

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
> [!IMPORTANT]
> Render Blueprints do not currently create Render Workflows. The Blueprint provisions the gateway, Postgres, and maintenance cron jobs; the Workflows service must be created separately.
### Prerequisites
- A Render workspace with access to Workflows and Sandboxes
- An Anthropic or OpenAI API key
- A fine-grained GitHub token for the repositories the factory will modify
- Optional Slack app credentials
### 1. Fork the repository
Create your own fork so agent definitions, workflow behavior, and infrastructure configuration remain under your control.
### 2. Create the Blueprint
Create a Render Blueprint from `render.yaml`. It provisions:
- `render-factory-gateway`
- `render-factory-db`
- Retention cron
- Stale-run reaper cron
### 3. Create the Workflows service
Create a Render Workflows service manually using the same repository and Dockerfile.
Start command:
```sh
node app/dist/src/workflows.js
```
Set `RENDER_WORKFLOW_SLUG` to the service’s workflow slug.
### 4. Configure environment variables
Use `.env.example` as the source of truth.
Core variables include:
```text
DATABASE_URL
RENDER_FACTORY_API_KEY
RENDER_FACTORY_ENCRYPTION_KEY
ANTHROPIC_API_KEY or OPENAI_API_KEY
RENDER_API_KEY
RENDER_WORKSPACE_ID
RENDER_WORKFLOW_SLUG
GITHUB_TOKEN
GITHUB_WEBHOOK_SECRET
GITHUB_BOT_LOGIN
SLACK_BOT_TOKEN          # optional
SLACK_SIGNING_SECRET     # optional
```
The manually created Workflows service also needs access to its database, model, Render, GitHub, and notification credentials.
### 5. Configure GitHub
Create a webhook pointing to:
```text
https://<gateway-host>/channels/github
```
Use the same secret as `GITHUB_WEBHOOK_SECRET`.
The current reference app uses a fine-grained personal access token with:
- Contents: read/write
- Pull requests: read/write
- Issues: read/write
Restrict it to only the repositories the factory should modify.
### 6. Configure Slack
Configure the Slack app with:
```text
Event Subscriptions: https://<gateway-host>/channels/slack
Interactivity:       https://<gateway-host>/slack/interactions
```
Required bot scopes are documented in `.env.example`.

---

## Security model
render-factory currently provides:
- Slack and GitHub webhook verification
- Bearer authentication for gateway APIs
- Encryption for stored OAuth credentials
- Isolated code execution in ephemeral sandboxes
- Per-agent iteration, token, cost, and time budgets
- Human approval gates for configured tools
- An append-only execution audit trail
- Automatic sandbox termination after workflow completion
Important boundaries:
- A sandbox isolates execution from the gateway and developer machines; it does not limit what an injected credential can access.
- The GitHub token can push branches and create or review pull requests.
- Tool approval is opt-in per agent/tool, not a comprehensive default-deny policy system.
- Do not expose the gateway publicly with development credentials.
- Use narrowly scoped tokens and rotate credentials regularly.

---

## Current limitations
Before using render-factory for production-sensitive work, be aware that:
- Render Workflows must be created manually.
- Render Sandboxes require product access.
- The included `deploy` tool demonstrates approval and resumption but does not perform a real deployment.
- `spec-to-pr` runs tests on a best-effort basis; failures do not currently block PR creation.
- `pr-fix` is triggered by submitted reviews on `agent/*` branches, but full review-comment ingestion remains incomplete.
- The richer scoped policy system described under `docs/future-work/` is not implemented.

---

## Contributing

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Node 22+, ESM-only, strict TypeScript, pnpm workspace.
