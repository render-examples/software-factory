# AGENTS.md

Instructions for coding agents working in this repository. Read this file first
when asked to add, modify, or extend anything in the render-factory.

---

## Project Structure

```
render-factory/
├── app/                    ← YOU CUSTOMIZE THIS
│   ├── agents/             Agent definitions (leaf + composition) in index.ts
│   ├── tools/              Tool sources (local, MCP, setup-injected)
│   ├── channels/           Inbound webhook adapters
│   ├── factory.ts          Flat factory root (agents, channels, config)
│   └── src/                Entrypoints (server.ts, workflows.ts)
├── packages/               ← INFRASTRUCTURE, DON'T TOUCH
│   ├── engine/             Agent loop, model clients, tools runtime
│   ├── sdk/                Public API: Agent(), Factory(), boot(), dispatch
│   ├── store/              Event log, projections, Postgres
│   ├── gateway/            HTTP service, auth, operator UI
│   └── sandbox/render/     Render Sandbox provider
└── docs/                   Architecture and spec documents
```

**Import from `@render-factory/sdk` for all authoring.** Never import from
`engine`, `store`, or `gateway` when writing agents or tools.

## How it boots

Both entrypoints (`server.ts`, `workflows.ts`) import the factory definition
from `app/factory.ts` and call `boot(factoryDef)`, which registers agents,
materializes tools, binds channels, and returns a running factory. No graph
traversal, no filesystem discovery.

---

## Authoring Agents

Agents are the **only authored primitive**. There are two kinds:

- **Prompt agents** use an LLM executor (model loop, tools, budget).
- **Composition agents** use a `run(ctx)` function for deterministic orchestration.

Both are created with `Agent()` and exported from `app/agents/index.ts`.

### Prompt agent (LLM)

```ts
import { Agent, md } from "@render-factory/sdk";
import sandboxTool from "../tools/sandbox/index.js";

export const researcher = Agent({
  id: "researcher",
  description: "Explores the repository to understand how to implement an issue",
  tools: [sandboxTool],
  budget: { maxIterations: 30, maxCostUsd: 8 },
  prompt: md`
    You are the **Research** phase of a Research → Plan → Implement loop.
    ...
  `,
});
```

### Composition agent (deterministic)

```ts
export const specToPr = Agent({
  id: "spec-to-pr",
  description: "Triage, research, plan, implement, open PR",
  plan: "standard",
  agents: [triage, researcher, planner, implementer],
  async run(ctx) {
    const research = await ctx.run(researcher, ctx.input.description);
    const plan = await ctx.run(planner, research);
    return ctx.run(implementer, plan);
  },
});
```

### Agent Definition Fields

**Common:**

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string | Unique agent identifier (required) |
| `description` | string | What the agent does |
| `input` | z.ZodType | Zod schema for validating/typing agent input |
| `output` | z.ZodType | Zod schema for structured output |

**Prompt agents (LLM):**

| Field | Type | Purpose |
|-------|------|---------|
| `prompt` | string | System prompt (use `md` tagged template) |
| `model` | string | Model tier: `small`, `medium`, `large` (or model ID) |
| `tools` | ToolSource[] | Tool sources this agent can access |
| `subagents` | AgentDef[] | Subagent definitions for delegation |
| `budget` | object | Execution limits |
| `sampling` | object | Temperature, topP, maxOutputTokens |
| `requireApproval` | ToolSource[] | Tools that pause for human approval |
| `interactive` | boolean | Marks as a conversational chat surface |
| `plan` | string | Render Workflows compute plan |

**Composition agents (deterministic):**

| Field | Type | Purpose |
|-------|------|---------|
| `agents` | AgentDef[] | Child agents available via `ctx.run()` |
| `run` | function | `(ctx: AgentContext) => Promise<T>` |
| `plan` | string | Render Workflows compute plan |

### `ctx.run()` — the only composition API

Every agent invocation inside a composition agent is a durable isolated task:

```ts
// Sequential — each step feeds the next
const research = await ctx.run(researcher, input);
const plan = await ctx.run(planner, research);
const impl = await ctx.run(implementer, plan);

// Parallel — independent work fans out
const [sec, perf, tests] = await Promise.all([
  ctx.run(securityAgent, diff),
  ctx.run(perfAgent, diff),
  ctx.run(testsAgent, diff),
]);
```

### `ctx.step()` for side effects

Wrap all side effects in `ctx.step()` for replay-safe memoization:

```ts
const pr = await ctx.step("open-pr", async () => {
  return gh.createPullRequest(repo, { title, head, base, body });
});
```

---

## The Factory Root

`app/factory.ts` is a **flat registry** of all agents and channels:

```ts
export default Factory({
  agents: [assistant, researcher, planner, implementer, specToPr, prReview],
  channels: [github, slack],
  config: { repos: ["owner/repo"] },
});
```

All agents are listed here. Composition agents and leaf agents are peers.
No dependency graph — agents resolve each other at runtime via `ctx.run()`.

---

## Adding Tools

Tools live in `app/tools/<source-id>/index.ts`. Each default-exports a
`ToolSource` created by `defineTool()` or `defineMcpSource()`.

### Simple tool

```ts
import { defineTool } from "@render-factory/sdk";

export default defineTool({
  id: "get_issue",
  description: "Read one GitHub issue.",
  inputSchema: { type: "object", properties: { repo: { type: "string" } } },
  async invoke(input, ctx) {
    return JSON.stringify(result);
  },
});
```

### Setup-injected tool

Tools that need runtime dependencies use `setup()`:

```ts
export default defineTool({
  id: "start_workflow",
  description: "Start a background agent...",
  inputSchema: { ... },
  setup(ctx) {
    return {
      id: "start_workflow",
      description: "...",
      inputSchema: { ... },
      async invoke(input, toolCtx) {
        const wf = ctx.workflows.get(input.name);
        return wf.dispatch(input.spec);
      },
    };
  },
});
```

### MCP server

```ts
import { defineMcpSource } from "@render-factory/sdk";

export default defineMcpSource({
  transport: "http",
  url: "https://mcp.example.com/mcp",
  headers: () => ({ Authorization: `Bearer ${process.env.TOKEN}` }),
});
```

---

## Adding Channels

Channels live in `app/channels/<name>.ts`. They target agents directly:

```ts
import { defineChannel, githubVerify } from "@render-factory/sdk";
import { specToPr } from "../agents/index.js";

export default defineChannel({
  id: "github",
  target: { agent: specToPr },
  verify: githubVerify(),
  match(req) { /* return { event } or null */ },
  async parse(req) { /* return { conversationId, input, target? } */ },
});
```

---

## Key Conventions

- **ESM-only** — all imports use `.js` extensions
- **Node 22+** — use modern APIs freely
- **Strict TypeScript** — `noEmit` for typecheck, no `any`
- **pnpm workspace** — run commands from root or use `pnpm --filter`
- **Tests** — Vitest, run with `pnpm test`
- **App runs through tsx** — no compilation needed for the private app
- **Published packages compile** — `pnpm build` compiles all packages
