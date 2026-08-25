# @render-factory/engine

The execution core for [render-factory](../../README.md): the agent loop and the
runtime vocabulary it depends on. Most applications use this via
[`@render-factory/sdk`](../sdk) rather than directly.

## Contents

- **`DefaultRunner`** — the LLM loop (D9): iterate → call model → dispatch tools, every persisting step expressed as `ctx.emit`. Handles budgets, structured output, skills, resume-by-replay, and the HITL approval gate.
- **`InProcessRunContext`** — the `RunContext` realization: event emission + span correlation, cancellation, `ToolContext.connection()` (OAuth token resolution + refresh), context-managed message history.
- **Tools** — `defineTool`, `defineToolSource`, `defineMcpSource`, `ToolEnvironment` (mount/dispose, collision checks), SSRF-guarded `fetch`.
- **Model clients** — Anthropic + OpenAI, tiers (`small`/`medium`/`large`), `estimateCost`, retry.
- **Context management** — default auto-compaction emitting `context.compacted`.

Depends only on `@render-factory/store`. Never imports the sdk (acyclic graph).
