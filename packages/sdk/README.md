# @render-agents/sdk

The public API for [render-agents](../../README.md): author markdown agents,
discover a project, compose a runtime, and run/orchestrate agents.

```ts
import { createRuntime, loadAgents, loadWorkflows } from "@render-agents/sdk";

const runtime = await createRuntime();          // store/model/dispatcher from env
const agents = await loadAgents(".", runtime);   // agents/*.md → AgentSet
const out = await agents.get("security").run("review this diff");
```

## Highlights

- **Authoring & discovery** — `loadAgents`, `loadWorkflows`, `loadWebhooks`, `loadToolSources` (convention directories), `defineTool`, `defineMcpSource`, `defineHook`.
- **Runtime composition** — `createRuntime({ store?, model?, dispatcher?, oauthRefreshers?, ... })` (the D5 composition root).
- **Execution** — `agent.run()` (in-process) vs `agent.task()` (durable/isolated); `workflow(handler)` with memoized `ctx.step()`.
- **HITL** — `resumeRun(runId, runtime)` re-drives a paused run after an out-of-band approval/input.
- **Testing** — `@render-agents/sdk/testing` exports `createTestRuntime` + `mockModel` (runs the real loop).

Re-exports the engine + store public types so most apps depend only on this package.
