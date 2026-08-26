# render-factory

An open-source, self-hosted fork-and-deploy template for building autonomous coding agent workflows that run on Render.

[Quickstart](#quickstart) · [Deploy](#deploy-to-render) · [Customize](#customize-your-factory) · [Architecture](#architecture)


## What it does

### Defining agents
You define agents in markdown, compose them as durable multi-step workflows, and deploy them to Render. The agents receive work from Slack and GitHub, execute code in sandboxes, and deliver results back to those surfaces automatically.

The template ships with four connected workflows:

- **Assistant (`chat-turn`)** — Slack message or API prompt → persistent thread → assistant response. After confirming the scope and target repository, the assistant can dispatch `spec-to-pr`. The assistant is given the Render MCP
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

Tools are the boundary between model reasoning and side effects. Local TypeScript
functions, Render Sandbox operations, and remote MCP servers all enter the agent
runtime through the same tool interface, so they share schema validation, approval
gates, tracing, and structured error handling.

### Authoring model

Tool sources are conventionally discovered from:

```text
app/tools/<source-id>/index.ts
```

The directory name is the source ID that agents reference. No central registry is
required: add the directory, default-export a tool source, and add it to an agent's
Markdown frontmatter.

```md
---
tools:
  - github_repos
  - sandbox
  - render
permissions:
  requireApproval:
    - render__trigger_deploy
---
```

An agent only sees the tools it declares. `tools` is the runtime allowlist, not just
prompt guidance.

Naming depends on the source shape:

- A single local tool is exposed as `<source-id>`.
- A multi-tool local source is exposed as `<source-id>__<tool-name>`.
- MCP tools are always exposed as `<source-id>__<server-tool-name>`.
- Referencing a bare source ID mounts every tool in that source.
- Referencing a namespaced tool such as `github__get_file` mounts only that tool.

Approvals can gate an entire source or one namespaced operation:

```md
tools: [github]
permissions:
  requireApproval:
    - github__push_code
```

Source IDs and approval references are validated when the project loads. Dynamic MCP
tool names are resolved from the server when an agent mounts the source; an unknown
namespaced tool is skipped with a runtime warning.

### Built-in tool sources

| Source | Type | Description |
|--------|------|-------------|
| `sandbox` | Local multi-tool source | Execute commands and read, write, patch, or search files in Render Sandboxes. Calls use an explicit `sandbox_id`. |
| `github_repos` | Local tool | List or search repositories available to the configured GitHub token. |
| `start_workflow` | Local tool | Dispatch a durable background workflow while preserving the calling thread. |
| `get_activity` | Local tool | Read a bounded recent window for a run or thread, with sequence and time filtering. |
| `render` | HTTP MCP source | Mount tools advertised by the Render MCP server under `render__*`. |
| `deploy` | Local demo tool | Demonstrates approval, pause, and resume. It currently returns a synthetic release rather than performing a real deployment. |

### Add a local tool

Create `app/tools/get_issue/index.ts`:

```ts
import { defineTool } from "@render-factory/sdk";

export default defineTool({
  name: "get_issue",
  description: "Read one GitHub issue.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "Repository as owner/name" },
      number: { type: "number", description: "Issue number" },
    },
    required: ["repo", "number"],
  },
  async invoke(input, ctx) {
    const { repo, number } = input as { repo: string; number: number };
    const token = ctx.env("GITHUB_TOKEN");
    if (!token) return { content: "GITHUB_TOKEN is not set", isError: true };

    const response = await ctx.fetch(
      `https://api.github.com/repos/${repo}/issues/${number}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );

    if (!response.ok) {
      return {
        content: `GitHub returned ${response.status}`,
        isError: true,
      };
    }

    return JSON.stringify(await response.json());
  },
});
```

Then grant it to an agent:

```md
---
tools: [get_issue]
---
```

`defineTool` accepts a JSON Schema for model input and an async `invoke` function.
The invocation can return a string or `{ content, isError }`. Its context provides
the run's abort signal, logger, environment lookup, run ID, OAuth connections, and
an SSRF-guarded `fetch`.

For a group of related operations, export a source created with
`defineToolSource(...)`. The tools are then namespaced, for example
`github__get_file` and `github__push_code`, so agents can mount the whole source or
individual operations.

### Add an MCP server

MCP servers use the same directory convention and agent allowlist. The runtime
connects when the source is mounted, discovers the server's tools and input schemas,
namespaces them with the directory ID, and closes the connection when the run
environment is disposed.

#### Streamable HTTP

Create `app/tools/linear/index.ts`:

```ts
import { defineMcpSource } from "@render-factory/sdk";

export default defineMcpSource({
  transport: "http",
  url: "https://mcp.example.com/mcp",
  headers: () => ({
    Authorization: `Bearer ${process.env.LINEAR_MCP_TOKEN}`,
  }),
});
```

If the server advertises `get_issue` and `update_issue`, agents see
`linear__get_issue` and `linear__update_issue`:

```md
---
tools:
  - linear__get_issue
  - linear__update_issue
permissions:
  requireApproval:
    - linear__update_issue
---
```

#### Stdio

Local or packaged MCP servers can be started as subprocesses:

```ts
import { defineMcpSource } from "@render-factory/sdk";

export default defineMcpSource({
  transport: "stdio",
  command: "npx",
  args: ["-y", "@example/acme-mcp-server"],
  env: {
    ACME_API_KEY: process.env.ACME_API_KEY ?? "",
  },
});
```

Stdio servers do not inherit the service's full environment. They receive only a
small process-launch environment plus values explicitly declared in `env`, which
prevents unrelated model, database, and encryption credentials from leaking into
tool subprocesses.

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
