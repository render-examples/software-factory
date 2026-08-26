# Sprint 01 — Public Type Contracts + Testing Utilities

**Status:** DRAFT
**Wave:** 0 — Foundations & Walking Skeleton
**Depends on:** 00 (scaffolding)
**Unblocks:** all subsequent sprints

---

## Goal

Land the entire [Type Reference](../specs/05-type-reference.md) as compiling, exported TypeScript interfaces/types across the four packages — the frozen contract that every later sprint implements against — plus the testing-utility *signatures* (`mockModel`, `createTestRuntime`) so tests can be authored before implementations exist.

---

## Foundational decisions in play

- [D5](../specs/00-foundations.md#d5--injectable-runtime--composition-root) — the `AgentRuntime` composition root and its dependencies are the central contract; defining them up front makes injection/testing trivial.
- [D9](../specs/00-foundations.md#d9--the-runner-is-pluggable-runcontext-is-the-full-platform-contract) — `RunContext` is the full platform contract; freezing it now lets the runner, engine, and gateway evolve independently.
- [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) — the `RunEvent` taxonomy is the one vocabulary; it must be exact and shared before any emitter or projection is written.

---

## Scope

**In:** every `interface`/`type`/function signature in the [Type Reference](../specs/05-type-reference.md), placed at its correct **physical** layer, exported, and compiling under strict TS. Functions are declared (signatures + stub bodies that throw `not implemented`) — no runtime behavior.

**Physical placement follows the acyclic graph, not the Type Reference's public-surface grouping** (see [Architecture at a Glance](../specs/00-foundations.md#architecture-at-a-glance) and the Type Reference's grouping note). The rule: **a type is defined at or below the lowest layer that consumes it**; `engine`/`store` must never import from `sdk`. Concretely:

- **`@render-factory/store` (bottom — persistence/event vocabulary + store-owned):** `RunEvent`, `RunEventRecord`, `EventCategory`, `EventLogStore`, `EventInterceptor` *(see below)*, `Message`, `ContentBlock`, `MessageRole`, `ToolResult`, `TokenUsage`, `Logger`, `idempotencyKey`, `CancelStore`, `SpanKind`, `SpanInfo`, `SpanOutcome`, `Tracer`, `RunStatus`, `SpanStatus`, `RunRecord`, `SpanRecord`, `RunStore`, `ListRunsOptions`, `ScheduleRecord`, `ScheduleStore`, and the operational persistence types `Thread`, `ThreadMessage`, `ThreadStore`, `ApprovalRequest`, `ApprovalStore`, `OAuthConnection`, `OAuthStore` (store owns all persistence; the gateway owns only their routes). *(`EventInterceptor` is a minimal, persistence-level append seam — `(event, meta) → continue | rewrite | reject` referencing only `RunEvent` — run pre-commit by `events.append`. It carries **no** authoring vocabulary; the `Hook` authoring contract lives in `engine` and is adapted onto this seam, then injected at runtime composition. See Sprint 15.)*
- **`@render-factory/engine` (depends on `store` — runtime vocabulary + engine-owned):** `RunContext`, `AgentRunner`, `AgentDefinition`, `ContextConfig`, `Permissions`, `RenderPlan`, `AgentInput`, `AgentOutput`, `AgentResult`, `PausedResult`, `RunPaused`, `RunOptions`, `TaskOptions`, `ModelSpec`, `ModelTier`, `SamplingParams`, `Budget`, `Tool`, `ToolContext`, `OAuthTokens`, `ToolSource`, `ResolvedSource`, `DefineToolSpec`, `DefineMcpSpec`, `SkillMetadata`, `SkillRegistry`, `Environment`, `MountedTools`, `ToolRegistry`, `ApprovalResult`, `Hook`, `HookResult`, `HookContext`, `HookRegistry`, `ContextManager`, `CompactionStrategy`, `DelegationLimits`, `ModelClient`, `ModelStreamEvent`, `CompleteArgs`, `CompleteResult`, `ToolSchema`, `RetryPolicy`, `ModelPricing`, `MODEL_PRICING`, `estimateCost`. *(`Hook*` live here — the authoring/runtime contract whose veto semantics are realized in the engine's dispatch path — and are adapted onto `store`'s `EventInterceptor`.)*
- **`@render-factory/sdk` (top — composition/authoring/orchestration; defines these + re-exports all of engine + store):** `AgentSet`, `Agent`, `AgentRuntime`, `RunnerRegistry`, `TaskDispatcher`, `DispatchOptions`, `CreateRuntimeOptions`, `createRuntime`, `loadAgents`, `workflow`, `WorkflowOptions`, `WorkflowContext`, `WorkflowDefinition`, `WebhookAdapter`, `WebhookMatch`, `defineTool`, `defineMcpSource`, `defineHook`.
- **`@render-factory/gateway` (depends on `sdk` + `store`):** `ConnectorSpec`, `ConnectorContext` (the HTTP-facing connector contracts). The thread/approval/OAuth **stores live in `store`** (above); the gateway implements their *routes* against those interfaces, importing them down the graph.
- **`@render-factory/sdk/testing`** subpath: `mockModel` and `createTestRuntime` signatures (forwarding engine/store types).
- **Re-export wiring:** `@render-factory/sdk` re-exports the full engine + store public vocabulary so callers import everything from one place — making the Type Reference's "Core (@render-factory/sdk)" grouping true at the *public-surface* level while the *definitions* live lower.

**Out:**
- Any implementation logic (all function bodies are `throw new Error("not implemented")` or `declare`).
- Validation rules, parsing, persistence (Sprints 02–05).
- Deciding *new* shapes — this sprint is a faithful transcription of the Type Reference; any needed change is a spec change first.

---

## Deliverables

- Typed modules per package at their physical layer (e.g. `store/` holds `event.ts`/`message.ts`/`hook.ts`/`tracer.ts`; `engine/` holds `agent.ts`/`tool.ts`/`context.ts`/`model.ts`; `sdk/` holds `runtime.ts`/`workflow.ts` + re-export barrels).
- A single source of truth per type — no duplicate definitions across packages; cross-package types are imported (down the graph only), not re-declared.
- `@render-factory/sdk/testing` entrypoint exporting `mockModel`/`createTestRuntime` signatures.
- `tsd` (or equivalent) type-level tests asserting the public surface compiles and key generics behave (`Agent.run<T>` threads `T` into `AgentOutput<T>.data`).

---

## Porting source

- Reference the existing template types for shape parity and to spot already-correct definitions: `agent-workflows-template/src/engine/types/*` (`agent.ts`, `tool.ts`, `model.ts`, `skill.ts`, `store.ts`, `trace.ts`, `environment.ts`, `logger.ts`, `webhook.ts`). Per [Porting principle 1](../specs/porting-map.md#4-porting-principles), port the *contracts*, adapting names to the spec (e.g. `AgentTask` → `Agent`, add `.task()`, `plan`, `runner`, `context`).
- The event-log types (`RunEvent`, `RunEventRecord`, `EventLogStore`) are **new** (D10) — no template source; transcribe directly from the [Type Reference](../specs/05-type-reference.md#runevent).

---

## Implementation notes

1. Transcribe verbatim from the [Type Reference](../specs/05-type-reference.md). Where the reference includes doc-comments, carry them over — they are normative guidance.
2. Place each type at its physical layer per the **Scope** split above, then resolve imports **down the graph only** (`sdk → engine → store`; `gateway → sdk/store`). Examples: `RunContext` (engine) imports `Tracer`/`Logger`/`RunEvent`/`Message` from `store`; `AgentRuntime` (sdk) imports `RunStore`/`Tracer` from store and `ModelClient`/`ContextManager` from engine. **`engine`/`store` must never import from `sdk`** — `tsc -b` project references must form a DAG, and each package must be independently installable.
   - The `engine → store` edge is the load-bearing decision (Option A); it lets `engine` own the runtime vocabulary while the shared persistence/event vocabulary lives in `store`. Validate it with a build-graph check: `store` builds with zero internal deps; `engine` builds depending only on `store`.
3. Stub function bodies (`defineTool`, `defineMcpSource`, `defineHook`, `workflow`, `loadAgents`, `createRuntime`, `estimateCost`, `mockModel`, `createTestRuntime`, `idempotencyKey`) to throw `not implemented` so the surface is callable for type tests but obviously unimplemented.
4. Add `tsd` assertions for the generics-bearing surfaces and the discriminated unions (`RunEvent`, `ContentBlock`, `ApprovalResult`, `AgentResult`, `HookResult`).

---

## Exit criteria / acceptance

- All five packages typecheck with the full public surface exported.
- `import { ... } from "@render-factory/sdk"` resolves every core type; `@render-factory/sdk/testing` resolves `mockModel`/`createTestRuntime`.
- `tsd` type tests pass, including: `Agent.run<{decision:string}>()` yields `AgentOutput<{decision:string}>`; `RunEvent` exhaustiveness over the documented union; `AgentResult` narrows on `status`.
- No type is declared in more than one package.
- **Build-graph guard passes:** `store` builds with zero internal deps; `engine` depends only on `store`; neither `engine` nor `store` imports from `sdk` (enforced in CI).
- Calling any stubbed function throws `not implemented` (proves wiring without faking behavior).

---

## Risks / open questions

- **Layering is now resolved (Option A):** persistence/event vocabulary in `store`, runtime vocabulary in `engine` (`engine → store`), `sdk` re-exports. The remaining risk is *drift* — if a later sprint finds a type that a lower layer consumes but that's been placed too high, move it **down** (and update the spec), never add an upward import. A CI build-graph check (no `sdk` import from `engine`/`store`) guards this.
- **`mockModel`/`createTestRuntime` placement:** signatures live in `@render-factory/sdk/testing`; implementations (Sprint 04+) depend on engine's `ModelClient` + store's in-memory `RunStore` — both below `sdk`, so no cycle.
- **Spec drift:** this sprint freezes the contract. Any discrepancy discovered while transcribing must be fixed in [`05-type-reference.md`](../specs/05-type-reference.md) first, then mirrored here — the spec stays the source of truth.
