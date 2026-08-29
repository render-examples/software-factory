# AGENTS.md

Instructions for coding agents working in this repository. Read this file first
when asked to add, modify, or extend anything in the render-factory.

---

## Project Structure

```
render-factory/
├── app/                    ← YOU CUSTOMIZE THIS
│   ├── agents/             TypeScript agent definitions (index.ts barrel)
│   ├── workflows/          Durable workflow orchestration
│   ├── tools/              Tool sources (local, MCP)
│   ├── channels/           Inbound webhook adapters
│   ├── factory.ts          Explicit factory root (workflows, channels, interactive agents)
│   └── src/                Entrypoints (server.ts, workflows.ts)
├── packages/               ← INFRASTRUCTURE, DON'T TOUCH
│   ├── engine/             Agent loop, model clients, tools runtime
│   ├── sdk/                Public API, define*, bootFactory, dispatch
│   ├── store/              Event log, projections, Postgres
│   ├── gateway/            HTTP service, auth, operator UI
│   └── sandbox/render/     Render Sandbox provider
└── docs/                   Architecture and spec documents
```

**Import from `@render-factory/sdk` for all authoring.** Never import from
`engine`, `store`, or `gateway` when writing agents, workflows, or tools.

## How it boots

Both entrypoints (`server.ts`, `workflows.ts`) import the factory definition
from `app/factory.ts` and call `bootFactory(factoryDef)`, which traverses the
typed dependency graph, validates all references, and materializes the runtime.
No filesystem discovery or compilation is involved.

---

## Authoring Agents

Agents are TypeScript definitions in `app/agents/index.ts`. Each is created
with `defineAgent()` and exported as a named constant.

### Example

```ts
import { defineAgent, md } from "@render-factory/sdk";
import sandboxTool from "../tools/sandbox/index.js";

export const researcher = defineAgent({
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

### Agent Definition Fields

**Common (use these):**

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string | Unique agent identifier (required) |
| `description` | string | What the agent does |
| `model` | string | Model tier: `small`, `medium`, `large` (or a specific model ID) |
| `tools` | ToolSource[] | Tool sources this agent can access (imported objects) |
| `subagents` | AgentDef[] | Subagent definitions this agent can delegate to |
| `budget` | object | Execution limits (see below) |
| `prompt` | string | System prompt, typically using the `md` tagged template |

**Budget fields:**

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `budget.maxIterations` | number | 25 | Max model call + tool call loops |
| `budget.maxCostUsd` | number | null | Max estimated cost in USD |
| `budget.maxWallSeconds` | number | none | Max wall-clock time |
| `budget.maxTokens` | number | none | Max total tokens (input + output) |

**Advanced (most agents don't need these):**

| Field | Type | Purpose |
|-------|------|---------|
| `provider` | `"anthropic"` \| `"openai"` | Override the default provider |
| `output` | z.ZodType | Structured output schema (Zod, converted to JSON Schema) |
| `requireApproval` | ToolSource[] | Tools that pause for human approval |
| `plan` | string | Render Workflows compute plan (`starter`, `standard`, `pro`) |
| `interactive` | boolean | Marks this as a conversational agent |
| `sampling.temperature` | number | Model temperature |
| `sampling.topP` | number | Top-p sampling |
| `sampling.maxOutputTokens` | number | Max output tokens per model call |
| `input` | z.ZodType | Zod schema for validating/typing agent input |

### Adding an agent

1. Define the agent in `app/agents/index.ts` using `defineAgent()`.
2. Import it in the workflow that uses it and add it to the workflow's `agents` array.
3. The factory graph is traversed automatically — no separate registration needed.

---

## Composing Workflows

Workflows live in `app/workflows/<name>/index.ts`. They default-export a
`defineWorkflow()` definition that declares its agent dependencies.

### Minimal workflow

```ts
import { defineWorkflow } from "@render-factory/sdk";
import { researcher } from "../../agents/index.js";

export default defineWorkflow({
  id: "my-workflow",
  agents: [researcher] as const,
  run: async (ctx) => {
    const result = await ctx.task(researcher, ctx.input);
    return { summary: result.text };
  },
});
```

### `ctx.task()` — the only execution API

Every agent invocation is a durable isolated task. Use `await` for sequential
steps and `Promise.all()` for parallel fan-out:

```ts
// Sequential — each step feeds the next
const research = await ctx.task(researcher, input);
const plan = await ctx.task(planner, research.text);
const impl = await ctx.task(implementer, plan.text);

// Parallel — independent work fans out
const [security, perf, tests] = await Promise.all([
  ctx.task(securityAgent, diff),
  ctx.task(perfAgent, diff),
  ctx.task(testsAgent, diff),
]);
```

### `ctx.step()` for side effects

Wrap all side effects in `ctx.step()` for replay-safe memoization:

```ts
const pr = await ctx.step("open-pr", async () => {
  return gh.createPullRequest(repo, { title, head, base, body });
});
```

### Registration

Workflows must be added to the factory root in `app/factory.ts`:

```ts
export default defineFactory({
  workflows: [specToPr, prReview, prFix],
  channels: [github, slack],
  interactive: [assistant],
});
```

Only workflows listed here (or reachable through channels) are dispatchable.
Agent dependencies are declared per-workflow and collected transitively at boot.

---

## Adding Tools

Tools live in `app/tools/<source-id>/index.ts`. Each default-exports a
`ToolSource` created by `defineTool()` or `defineMcpSource()`.

### Single local tool

```ts
import { defineTool } from "@render-factory/sdk";

export default defineTool({
  id: "get_issue",
  description: "Read one GitHub issue.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string" },
      number: { type: "number" },
    },
    required: ["repo", "number"],
  },
  async invoke(input, ctx) {
    const { repo, number } = input as { repo: string; number: number };
    return JSON.stringify(result);
  },
});
```

### MCP server (HTTP)

```ts
import { defineMcpSource } from "@render-factory/sdk";

export default defineMcpSource({
  transport: "http",
  url: "https://mcp.example.com/mcp",
  headers: () => ({ Authorization: `Bearer ${process.env.TOKEN}` }),
});
```

### Using tools in agents

Import the tool source and reference it in the agent's `tools` array:

```ts
import sandboxTool from "../tools/sandbox/index.js";

export const implementer = defineAgent({
  tools: [sandboxTool],
  // ...
});
```

---

## Adding Channels

Channels live in `app/channels/<name>.ts`. They default-export a `defineChannel()`
definition that references workflow or agent targets as imported objects.

```ts
import { defineChannel, githubVerify } from "@render-factory/sdk";
import specToPr from "../workflows/spec-to-pr/index.js";

export default defineChannel({
  id: "github",
  target: { workflow: specToPr },
  verify: githubVerify(),
  match(req) { /* return { event } or null */ },
  async parse(req) { /* return { conversationId, input, target? } */ },
});
```

Channels must be added to the factory root in `app/factory.ts`.

---

## The Factory Root

`app/factory.ts` is the single composition boundary. It lists:
- **workflows** — publicly dispatchable via the HTTP API
- **channels** — inbound/outbound message surfaces
- **interactive** — conversational agents exposed as chat entrypoints

All agent, tool, and subagent dependencies are collected transitively from
workflows and interactive agents. You never list pipeline agents in the factory.

---

## Key Conventions

- **ESM-only** — all imports use `.js` extensions
- **Node 22+** — use modern APIs freely
- **Strict TypeScript** — `noEmit` for typecheck, no `any`
- **pnpm workspace** — run commands from root or use `pnpm --filter`
- **Tests** — Vitest, run with `pnpm test`
- **App runs through tsx** — no compilation needed for the private app
- **Published packages compile** — `pnpm build` compiles all packages
