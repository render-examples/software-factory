# AGENTS.md

Instructions for coding agents working in this repository. Read this file first
when asked to add, modify, or extend anything in the render-factory.

---

## Project Structure

```
render-factory/
├── app/                    ← YOU CUSTOMIZE THIS
│   ├── agents/             Markdown agent definitions
│   ├── workflows/          Durable workflow orchestration
│   ├── tools/              Tool sources (local, MCP)
│   ├── channels/           Inbound webhook adapters
│   └── src/                Entrypoints (server.ts, workflows.ts)
├── packages/               ← INFRASTRUCTURE, DON'T TOUCH
│   ├── engine/             Agent loop, model clients, tools runtime
│   ├── sdk/                Public API, loaders, dispatch, workflow()
│   ├── store/              Event log, projections, Postgres
│   ├── gateway/            HTTP service, auth, operator UI
│   └── sandbox/render/     Render Sandbox provider
└── docs/                   Architecture and spec documents
```

**Import from `@render-factory/sdk` for all authoring.** Never import from
`engine`, `store`, or `gateway` when writing agents, workflows, or tools.

## How it boots

Both entrypoints (`server.ts`, `workflows.ts`) call `bootFactory(root)` which
auto-discovers agents, tools, workflows, channels, hooks, and runners from the
`app/` directory by convention. Adding or removing a file is all it takes to
add or remove a capability — no manual imports or registration.

### Factory config (optional)

Create `app/factory.config.mjs` to set factory-wide settings:

```js
/** @type {import("@render-factory/sdk").FactoryConfig} */
export default {
  repos: ["myorg/*"],  // restrict which repos the factory can operate on
};
```

Use `.mjs` (not `.ts`) so the config works under plain `node` in production.
Omit the file entirely to accept all defaults (all repos the GitHub token can reach).

---

## Authoring Agents

Agents live in `app/agents/<name>.md`. The file name (without extension) is the
agent's ID, referenced from workflows as `ctx.agents.get("<name>")`.

### Format

```md
---
description: One-line description of what this agent does
model: large
tools: [sandbox]
budget:
  maxIterations: 60
  maxCostUsd: 15
---

You are a... (system prompt body)
```

### Frontmatter Fields

**Common (use these):**

| Field | Type | Purpose |
|-------|------|---------|
| `description` | string | What the agent does (required for subagent routing) |
| `model` | string | Model tier: `small`, `medium`, `large` (or a specific model ID) |
| `tools` | string[] | Tool sources this agent can access (enforced allowlist) |
| `budget` | object | Execution limits (see below) |

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
| `output` | JSON Schema object | Enforce structured output (agent must return valid JSON) |
| `permissions.requireApproval` | string[] | Tool IDs that pause for human approval |
| `plan` | string | Render Workflows compute plan (`starter`, `standard`, `pro`) |
| `interactive` | boolean | Marks this as a conversational agent (thread-scoped memory) |
| `sampling.temperature` | number | Model temperature |
| `sampling.topP` | number | Top-p sampling |
| `sampling.maxOutputTokens` | number | Max output tokens per model call |
| `context.compaction` | string | Context compaction strategy |
| `context.maxContextTokens` | number | Max context window budget |
| `subagents` | string[] | Named subagents this agent can delegate to |
| `skills` | string[] | Skill documents loaded into context |
| `runner` | string | Custom runner name (advanced) |

### Discovery

Agents are auto-discovered by `bootFactory()` (or `loadAgents()`) from the
`agents/` directory. Just create a `.md` file — no imports or registration
needed. Files starting with `_` (like `_shared.md`) are merged into all agents
as shared defaults.

---

## Composing Workflows

Workflows live in `app/workflows/<name>/index.ts`. They default-export a
`workflow()` definition.

### Minimal workflow

```ts
import { workflow } from "@render-factory/sdk";

export default workflow({ name: "my-workflow" }, async (ctx) => {
  const result = await ctx.agents.get("researcher").run(ctx.input);
  return { summary: result.text };
});
```

### `run()` vs `task()`

Use `run()` when the next line needs this agent's output. Use `task()` when you
want durability, parallelism, or a different compute plan.

```ts
// Sequential — each step feeds the next
const research = await ctx.agents.get("researcher").run(input);
const plan = await ctx.agents.get("planner").run(research.text);
const impl = await ctx.agents.get("implementer").run(plan.data);

// Parallel — independent work fans out
const [security, perf, tests] = await Promise.all([
  ctx.agents.get("security").task(diff),
  ctx.agents.get("performance").task(diff),
  ctx.agents.get("tests").task(diff),
]);
```

**Decision rule:**

- Is this one of several agents that can run at the same time? → `task()`
- Does this agent need a bigger compute plan? → `task()`
- Otherwise → `run()` (simpler, faster, no dispatch overhead)

Both return `AgentOutput<T>` with `.text` and `.data`. Both are replay-safe
(deterministic child run IDs, memoized on completion).

### `ctx.step()` for side effects

Wrap all side effects (API calls, file I/O, anything non-deterministic) in
`ctx.step()` for replay-safe memoization:

```ts
const pr = await ctx.step("open-pr", async () => {
  return gh.createPullRequest(repo, { title, head, base, body });
});
```

If the workflow crashes and restarts, completed steps return their cached result
instead of re-executing. Step names must be unique within a single handler.

### Registration

Workflows are auto-discovered by `bootFactory()` from `app/workflows/<name>/index.ts`.
Just create the directory and file — no manual imports needed. The directory name
becomes the workflow name.

If you've ejected to explicit imports (not using `bootFactory`), add the workflow
to both `app/src/server.ts` and `app/src/workflows.ts` manually.

---

## Adding Tools

Tools live in `app/tools/<source-id>/index.ts`. The directory name is the source
ID that agents reference in their `tools:` frontmatter.

### Single local tool

```ts
import { defineTool } from "@render-factory/sdk";

export default defineTool({
  name: "get_issue",
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
    // ... implementation
    return JSON.stringify(result);
  },
});
```

Agent mounts it as: `tools: [get_issue]`

### Multi-tool source

```ts
import { defineToolSource } from "@render-factory/sdk";

export default defineToolSource({
  name: "github",
  tools: [getFileTool, pushCodeTool, createPrTool],
});
```

Agent mounts all tools: `tools: [github]`
Agent mounts one tool: `tools: [github__get_file]`

### MCP server (HTTP)

```ts
import { defineMcpSource } from "@render-factory/sdk";

export default defineMcpSource({
  transport: "http",
  url: "https://mcp.example.com/mcp",
  headers: () => ({ Authorization: `Bearer ${process.env.TOKEN}` }),
});
```

### MCP server (stdio)

```ts
import { defineMcpSource } from "@render-factory/sdk";

export default defineMcpSource({
  transport: "stdio",
  command: "npx",
  args: ["-y", "@example/mcp-server"],
  env: { API_KEY: process.env.API_KEY ?? "" },
});
```

### Namespacing rules

- Single tool → exposed as `<source-id>`
- Multi-tool source → exposed as `<source-id>__<tool-name>`
- MCP tools → always `<source-id>__<server-tool-name>`

### Registration

Tools are auto-discovered by `bootFactory()` from `app/tools/<source-id>/index.ts`.
Just create the directory and file — no manual imports needed. The directory name
becomes the source ID that agents reference in `tools:`.

If a tool needs runtime state (like access to the workflow map or the store),
export a `bind(ctx)` function alongside the default export:

```ts
export default defineTool({ ... });

export function bind(ctx: { runtime: AgentRuntime; workflows: Map<string, WorkflowDefinition> }) {
  // receive runtime state after the full project is assembled
}
```

`bootFactory()` calls `bind()` automatically on every tool source that exports it.

---

## Configuring Policies

### Approval gates

Add `permissions.requireApproval` to an agent's frontmatter with tool IDs that
should pause for human approval before executing:

```yaml
---
tools: [sandbox, deploy]
permissions:
  requireApproval:
    - deploy
---
```

Tool IDs follow the namespacing rules above. For a namespaced tool:

```yaml
permissions:
  requireApproval:
    - github__push_code
```

When a gated tool is called, the run emits `input.requested` and pauses. An
operator resolves it via the operator UI or `POST /inputs/:id/provide`.

### Budget enforcement

Budget fields in agent frontmatter are enforced at runtime. When any limit is
hit, the agent run terminates with a budget-exceeded error:

- `maxIterations` — counts each model-call-then-tool-execution cycle
- `maxCostUsd` — estimated from model pricing tables (input + output tokens)
- `maxWallSeconds` — wall-clock time from run start
- `maxTokens` — total tokens consumed across all model calls

---

## Adding Channels

Channels live in `app/channels/<name>.ts`. They are auto-discovered by
`bootFactory()` — the filename (without extension) becomes the channel ID,
and the gateway mounts it at `POST /channels/<name>`.

A channel default-exports an object with `target`, `verify`, `match`, and `parse`:

```ts
import type { Channel } from "@render-factory/sdk";
import { githubVerify } from "@render-factory/sdk";

const channel: Channel = {
  target: { workflow: "my-workflow" },
  verify: githubVerify(),
  match(req) { /* return { event } or null */ },
  async parse(req) { /* return { conversationId, input, target? } */ },
};
export default channel;
```

Optionally add a `deliver` method for outbound replies (e.g., posting to Slack).

---

## Key Conventions

- **ESM-only** — all imports use `.js` extensions
- **Node 22+** — use modern APIs freely
- **Strict TypeScript** — `noEmit` for typecheck, no `any`
- **pnpm workspace** — run commands from root or use `pnpm --filter`
- **Tests** — Vitest, run with `pnpm test`
- **Build** — `pnpm build` compiles all packages
