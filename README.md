# render-agents

Build production-grade AI agents on Render with markdown-first authoring, durable orchestration, and built-in ops.

`render-agents` gives you a full platform for agent systems:

- **Authoring that stays simple**: agents are `agents/*.md` files (prompt + config).
- **Runtime that scales**: same code path locally and on Render.
- **Durability by default**: append-only event log, replay-safe workflows, queue-backed chat lane.
- **Operational features built in**: approvals (HITL), context management, OAuth connections, schedules, and retention.
- **Deep observability**: spans, messages, tool calls, and costs from one canonical event stream.

---

## Why choose render-agents

- **Fast to start**: `npm create render-agents` scaffolds a complete, deployable project.
- **Clear mental model**: `agent.run()` for in-process calls, `agent.task()` for isolated durable calls.
- **Debuggable systems**: every meaningful event is persisted and streamable.
- **Production-ready architecture**: gateway + worker lanes + Postgres, not a toy loop.

---

## Key Features and Capabilities

- **Markdown agents** with frontmatter for model, tools, budget, approvals, plan, and structured output.
- **Workflow orchestration** with deterministic `ctx.step()` replay semantics.
- **Two execution lanes**:
  - durable, isolated tasks on Render Workflows,
  - interactive chat on warm workers backed by `run_jobs`.
- **Event-sourced platform model**: `run_events` is canonical; runs/spans/messages/approvals are projections.
- **Tooling support** for local tools, MCP sources, and dynamic subagent delegation (in-process or isolated).
- **Operator UI at `/ui`** for runs, traces, event log, approvals, chat, schedules, and ops.

---

## Architecture Overview

```text
Triggers (HTTP / webhook / cron / chat)
                 |
              Gateway
    (ui, auth, API, SSE, routing)
          /                 \
   Lane A (durable)      Lane B (interactive)
 workflow roots via      run_jobs queue
 Render Workflows        + warm chat worker
          \                 /
             Postgres Store
   run_events (canonical log) + projections
```

Monorepo package responsibilities:

| Package | Role |
|---|---|
| [`@render-agents/sdk`](packages/sdk) | Public API: runtime creation, loading, workflows, dispatch, worker |
| [`@render-agents/engine`](packages/engine) | Agent loop, tools, model clients, context management |
| [`@render-agents/store`](packages/store) | Event log, projections, queue, delta bus, retention, persistence |
| [`@render-agents/gateway`](packages/gateway) | HTTP service, auth, routes, SSE, OAuth, operator UI |
| [`create-render-agents`](packages/create-render-agents) | Scaffolder (`npm create`) |

---

## Agent Authoring Overview

Agents are markdown files in `agents/`.

```md
---
model: medium
description: Security reviewer
tools: [github]
skills: [security-patterns]
permissions:
  requireApproval: [github]
budget:
  maxIterations: 20
  maxCostUsd: 5
output:
  type: object
  properties:
    decision: { type: string, enum: [approve, reject] }
---

Review the patch for security risks and return a decision.
```

Common authoring building blocks:

- **Tools**: `tools/<name>/index.ts` (`defineTool` or `defineMcpSource`)
- **Skills**: `skills/<name>/SKILL.md`
- **Workflows**: `workflows/<name>/index.ts` (`workflow(async (ctx) => { ... })`)
- **Shared defaults**: `agents/_shared.md`

---

## Quickstart Commands

### 1) Scaffold a new project

```sh
npm create render-agents@latest my-agents
cd my-agents
npm install
```

### 2) Configure and run locally

```sh
cp .env.example .env
# set ANTHROPIC_API_KEY or OPENAI_API_KEY
# set RENDER_AGENTS_API_KEY
npm run dev
```

This starts the gateway on `http://localhost:3000` (inline mode by default).

### 3) Dispatch a workflow

```sh
curl -X POST localhost:3000/workflows/code-review \
  -H "Authorization: Bearer $RENDER_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":{"diff":"--- a/app.ts\n+++ b/app.ts\n+ const x = 1"}}'
```

### 4) Open the operator UI

- Visit `http://localhost:3000/ui`
- Sign in with your API key
- Inspect runs, traces, approvals, and chat live

---


## Contributing to this repo

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm check:bundle-size
```

Node 20+, ESM-only, strict TypeScript.
