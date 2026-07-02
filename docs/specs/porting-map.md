# Implementation Ownership Map

**Status:** NON-NORMATIVE
**Date:** 2026-07-02

This appendix is a contributor map for "where should this change live?" across the current monorepo.

It is intentionally implementation-focused and does not define product behavior contracts.

---

## By Concern

| Concern | Primary package | Key modules |
|---|---|---|
| Runtime composition and boot wiring | `@render-agents/sdk` | `src/runtime.ts`, `src/agents.ts` |
| Workflow orchestration + deterministic replay | `@render-agents/sdk` | `src/workflow.ts` |
| Dispatcher integration (Render vs in-process) | `@render-agents/sdk` | `src/dispatch.ts` |
| Chat worker execution lane | `@render-agents/sdk` | `src/worker.ts`, `src/submit.ts` |
| Markdown/frontmatter loading and validation | `@render-agents/sdk` | `src/loader/*` |
| Agent loop behavior | `@render-agents/engine` | `src/default-runner.ts` |
| Run context (approval, cancel, history, OAuth, deltas) | `@render-agents/engine` | `src/run-context.ts` |
| Tool mounting and MCP sources | `@render-agents/engine` | `src/tool-impl.ts`, `src/mcp-client.ts` |
| Context compaction | `@render-agents/engine` | `src/context-manager-impl.ts` |
| Event taxonomy and append contracts | `@render-agents/store` | `src/events.ts` |
| Projection folding | `@render-agents/store` | `src/projections.ts` |
| Postgres/memory persistence | `@render-agents/store` | `src/pg/postgres-store.ts`, `src/memory-store.ts` |
| Durable queue + delta streaming infra | `@render-agents/store` | `src/job-queue.ts`, `src/delta-bus.ts` |
| Gateway route behavior and lane routing | `@render-agents/gateway` | `src/app.ts`, `src/routes/*` |
| Auth/session behavior | `@render-agents/gateway` | `src/auth.ts`, `src/ui-session.ts` |
| Operator UI behavior | `@render-agents/gateway` | `ui/src/*` |
| Scaffolded project defaults | `create-render-agents` | `src/blueprint.ts`, `src/index.ts` |

---

## Change Placement Rules

1. **Behavior contracts first**
   - If changing user-visible runtime behavior, update package code and matching spec layer (`01`-`04`, `06`).

2. **Type ownership discipline**
   - Persistence/event types belong in `store`.
   - Loop/runtime contracts belong in `engine`.
   - Composition APIs and wiring belong in `sdk`.
   - HTTP and UI concerns belong in `gateway`.

3. **Avoid cross-layer leakage**
   - `store` should not import from `gateway`.
   - `engine` and `store` should not depend on `sdk` for type definitions.

4. **Queue vs workflow lane changes**
   - Lane A root semantics: `workflow.ts` + `dispatch.ts` + gateway root routing.
   - Lane B chat semantics: `submit.ts` + `worker.ts` + thread routes.

---

## Quick Triage Checklist

Before implementing a feature/fix, answer:

1. Is this a loop behavior change (`engine`) or composition/routing change (`sdk`/`gateway`)?
2. Does it require a new event or projection (`store/events.ts` + `store/projections.ts`)?
3. Does it alter API/route contracts (`gateway/routes/*`)?
4. Does scaffolding need to emit new defaults (`create-render-agents/blueprint.ts`)?
5. Which spec layer must be updated to keep docs aligned?

