# Factory Config & Auto-Discovery Spec

Simplification item 1: separate the product surface from the framework surface.

---

## Problem

Today, `server.ts` and `workflows.ts` are each ~80–130 lines of explicit imports and manual `Map` construction. A founder adding a tool, workflow, or channel must edit both entrypoints. This is the most common reason a founder has to read framework internals on day one.

Agent discovery already works by convention — `loadAgentsFromDir` walks `app/agents/*.md` and builds an `AgentSet` without explicit imports. Tools, workflows, and channels don't have this; they require manual wiring.

The fix is two things:

1. **Auto-discovery** for tools, workflows, and channels — the same convention `loadAgents` already uses for agents.
2. **A minimal factory config** for the one thing that doesn't belong in any individual workflow or agent: which repos the factory is allowed to operate on.

---

## What the factory config covers

```ts
// app/factory.config.ts
import { defineFactory } from "@render-factory/sdk";

export default defineFactory({
  // Which repos the factory may clone, push to, and open PRs on.
  // Glob patterns matched against "owner/repo". Omit to allow any repo
  // the GITHUB_TOKEN can reach.
  repos: ["myorg/*"],
});
```

That's it. One field.

### What does NOT go in the factory config

| Concern | Where it lives | Why |
|---------|---------------|-----|
| Model tier | Agent frontmatter (`model: large`) | Per-agent decision; agents already declare this |
| Budget | Agent frontmatter (`budget:`) | Per-agent decision |
| Shipping policy | Workflow code or agent `permissions:` | Per-workflow decision — `spec-to-pr` decides whether to open a draft; `pr-review` decides whether to auto-approve |
| Tool approval gates | Agent frontmatter (`permissions.requireApproval`) | Per-agent decision — the security reviewer doesn't need the same gates as the assistant |
| Credentials | Environment variables | Operational concern, not config |
| Channels to enable | Presence/absence of files in `app/channels/` | Auto-discovered; delete the file to disable |

The factory config is deliberately thin. It exists because repo allowlisting is a factory-wide concern that doesn't belong in any single workflow or agent. Everything else already has a home.

---

## Auto-discovery

### Current state

| Resource | Discovery | Registration |
|----------|-----------|-------------|
| Agents | `loadAgentsFromDir()` walks `app/agents/*.md` | Automatic via `loadAgents(root, runtime)` |
| Tools | Manual imports in `server.ts` + `workflows.ts` | Manual `Map` construction |
| Workflows | Manual imports in `server.ts` + `workflows.ts` | Manual `Map` construction + `bindWorkflow()` |
| Channels | Manual imports in `server.ts` + `workflows.ts` | Manual `Map` construction |

### Proposed state

| Resource | Discovery | Registration |
|----------|-----------|-------------|
| Agents | `loadAgentsFromDir()` — unchanged | Automatic via `loadAgents(root, runtime)` — unchanged |
| Tools | `discoverDirectory(toolsDir, { pattern: "ts-index" })` — **already exists** | New: `loadToolSources(root)` dynamically imports discovered modules |
| Workflows | `discoverDirectory(workflowsDir, { pattern: "ts-index" })` — **already exists** | New: `loadWorkflows(root, runtime)` dynamically imports and binds |
| Channels | `discoverDirectory(channelsDir, { pattern: "ts-file" })` — **already exists** | New: `loadChannels(root)` dynamically imports discovered modules |

The `discoverDirectory` function already handles all four discovery patterns (`md`, `ts-index`, `ts-file`, `skill`). The gap is only on the import + registration side.

### `bootFactory(root)`

A single function that replaces the 80-line entrypoints:

```ts
// app/src/server.ts (after)
import { bootFactory } from "@render-factory/sdk";
import { startGateway } from "@render-factory/gateway";

const root = new URL("../..", import.meta.url).pathname;
const { runtime, workflows, channels } = await bootFactory(root);

const { port } = await startGateway({
  runtime,
  workflows,
  channels,
  defaultWorkflow: "spec-to-pr",
  defaultAgent: "assistant",
});
console.log(`gateway listening on :${port}`);
```

```ts
// app/src/workflows.ts (after)
import { task } from "@renderinc/sdk/workflows";
import { bootFactory, workflowTaskHandler, agentTaskHandler, computeRequiredPlans } from "@render-factory/sdk";

const root = new URL("../..", import.meta.url).pathname;
const { runtime, workflows } = await bootFactory(root);

const plans = computeRequiredPlans([...runtime.agentDefinitions.values()]);
for (const plan of plans) {
  task({ name: `agent@${plan}`, plan }, (input) => agentTaskHandler(input, runtime, (n) => runtime.agentDefinitions.get(n)));
  task({ name: `workflow@${plan}`, plan }, (args) => workflowTaskHandler(args, workflows));
}
```

### What `bootFactory` does

```ts
export async function bootFactory(root: string): Promise<{
  runtime: AgentRuntime;
  workflows: Map<string, WorkflowDefinition>;
  channels: Map<string, Channel>;
}> {
  // 1. Load factory config (optional — missing file = defaults)
  const config = await loadFactoryConfig(root);

  // 2. Auto-discover and dynamically import tool sources
  const toolSources = await loadToolSources(root);

  // 3. Resolve model from MODEL_TIER env var (existing behavior)
  const { spec } = resolveModelSpec(process.env.MODEL_TIER ?? "medium");
  const model = resolveClient(spec);

  // 4. Create runtime with discovered tools
  const tenantId = process.env.TENANT_ID ?? "default";
  const runtime = await createRuntime({ tenantId, model, toolSources });

  // 5. Load agents from markdown (existing behavior)
  await loadAgents(root, runtime);

  // 6. Auto-discover and dynamically import workflows, bind to runtime
  const workflows = await loadWorkflows(root, runtime);

  // 7. Auto-discover and dynamically import channels
  const channels = await loadChannels(root);

  // 8. Late-bind runtime state for tools that need it
  //    (discovered via a convention — tools export bind* functions)
  await lateBindToolSources(toolSources, { runtime, workflows });

  // 9. Apply factory config (repo allowlist → injected into runtime)
  if (config.repos) {
    runtime.repoAllowlist = config.repos;
  }

  return { runtime, workflows, channels };
}
```

### Late-binding problem

Three tool sources currently require late-binding:

```ts
// Current: manual calls in both entrypoints
bindWorkflows(workflows);           // start_workflow needs the workflow map
bindStore(runtime.store);           // start_workflow needs the store
bindActivityRuntime(runtime);       // get_activity needs the runtime
```

This works because tools are manually imported, so the caller knows which bind functions exist. With auto-discovery, we need a convention.

**Proposed convention:** tool source modules may export a `bind(ctx)` function. `bootFactory` calls it after all resources are assembled:

```ts
// app/tools/start_workflow/index.ts
export default defineToolSource({ ... });

export function bind(ctx: { runtime: AgentRuntime; workflows: Map<string, WorkflowDefinition> }) {
  bindWorkflows(ctx.workflows);
  bindStore(ctx.runtime.store);
}
```

If a tool source default-exports something with a `bind` property, or the module exports a named `bind`, `bootFactory` calls it. Tools without a `bind` export are mounted as-is.

---

## Repo allowlist enforcement

The factory config's `repos` field is enforced at two points:

1. **Workflow level:** `spec-to-pr`, `pr-review`, and `pr-fix` check the repo from their input against the allowlist before proceeding. If the repo isn't allowed, the workflow returns `{ skipped: "repo not allowed" }`.

2. **Channel level:** the GitHub channel's `parse()` can reject events from repos not on the allowlist before they create a thread.

Glob matching is simple: `["myorg/*"]` matches any repo under `myorg`. `["myorg/frontend", "myorg/api"]` matches exactly those two. Omitting `repos` or setting it to `["*/*"]` allows all repos the token can reach.

The allowlist is a safety net, not a permissions system. The GitHub token's scoping is the real boundary — the allowlist prevents the factory from accidentally operating on repos it has token access to but shouldn't touch.

---

## Explicit-import escape hatch

`bootFactory` is the convenience path. The explicit-import path (today's `server.ts` / `workflows.ts`) continues to work unchanged. A founder who outgrows auto-discovery can replace `bootFactory(root)` with manual imports and `createRuntime()` directly — the same way you can eject from a framework's defaults.

The two paths produce identical runtime objects. `bootFactory` is sugar over the same `createRuntime`, `loadAgents`, `bindWorkflow`, and `startGateway` calls.

---

## Implementation scope

| Task | Effort | Changes |
|------|--------|---------|
| `loadToolSources(root)` — discover + dynamic import | Small | New function in `sdk/src/loader/` |
| `loadWorkflows(root, runtime)` — discover + dynamic import + bind | Small | New function in `sdk/src/loader/` |
| `loadChannels(root)` — discover + dynamic import | Small | New function in `sdk/src/loader/` |
| `loadFactoryConfig(root)` — load + validate `factory.config.ts` | Small | New function in `sdk/src/loader/`, Zod schema |
| `bootFactory(root)` — compose the above | Small | New function in `sdk/src/runtime.ts` or new file |
| Late-bind convention (`bind` export) | Small | Update `start_workflow` and `get_activity` tool sources, convention doc |
| Repo allowlist enforcement | Small | Guard in `spec-to-pr`, `pr-review`, `pr-fix`, and GitHub channel |
| Simplify `app/src/server.ts` | Small | Replace ~70 lines with ~10 |
| Simplify `app/src/workflows.ts` | Medium | Replace ~100 lines with ~20 (Render Workflows task registration stays explicit) |
| Tests | Medium | Loader tests for each discovery function, integration test for `bootFactory` |

**Total estimate:** ~2 days.

---

## What this changes for a founder

**Before:** fork → read `server.ts` and `workflows.ts` to understand how tools/workflows/channels are wired → add a tool by creating the directory AND importing it in both entrypoints → deploy.

**After:** fork → add a tool by creating `app/tools/<name>/index.ts` → deploy. Adding a workflow or channel works the same way. Removing one means deleting the directory.

The twelve agent files, four workflows, six tool sources, and two channels all continue to work without the founder touching any wiring code. The only config they might write is `factory.config.ts` with a repo allowlist — and even that is optional.
