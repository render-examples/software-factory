# Type Reference

**Status:** IMPLEMENTED (living)
**Date:** 2026-07-02
**Layer:** L5 - API and type ownership.

This is the concise, implementation-aligned type map. Exact signatures are in source files listed below.

---

## How To Read This

- **Public import surface** is primarily `@render-agents/sdk` (`packages/sdk/src/index.ts`).
- `sdk` re-exports many contracts that are physically defined in:
  - `@render-agents/engine` (runtime/loop/tool contracts),
  - `@render-agents/store` (event/store/persistence contracts).
- `@render-agents/gateway` exports HTTP-oriented contracts and helpers.

---

## SDK Public Surface (`@render-agents/sdk`)

Authoritative file: `packages/sdk/src/index.ts`

### Core runtime and orchestration

- `createRuntime`, `AgentRuntime`, `CreateRuntimeOptions`, `ExecutionMode`
- `loadAgents`, `AgentSet`, `Agent`
- `workflow`, `bindWorkflow`, `WorkflowDefinition`, `WorkflowContext`, `WorkflowOptions`
- `resumeRun`, `driveAgentTurn`
- `submitRootRun`
- `runWorker`, `runWorkerLoop`, `buildJobProcessor`

### Loader utilities

- `loadWorkflows`
- `loadWebhooks`
- `loadToolSources`
- `loadHooks`
- `loadRunners`

### Dispatch contracts

- `TaskDispatcher`, `DispatchOptions`, `RootDispatchJob`
- `InProcessDispatcher`, `RenderWorkflowsDispatcher`
- `agentTaskHandler`, `workflowTaskHandler`

### Authoring helpers

- `defineTool`
- `defineMcpSource`
- `defineHook`

### Testing subpath

Authoritative file: `packages/sdk/src/testing.ts`

- `mockModel`
- `createTestRuntime`

---

## Engine-Owned Contracts (`@render-agents/engine`)

Authoritative file: `packages/engine/src/index.ts`

### Agent and execution contracts

- `AgentDefinition`, `AgentInput`, `AgentOutput`
- `RunOptions`, `TaskOptions`, `AgentRunner`, `RunContext`
- `RunPaused`, `RunCancelled`
- `Budget`, `Permissions`, `ContextConfig`

### Tool contracts

- `Tool`, `ToolContext`, `ToolSource`, `MountedTools`, `Environment`
- `DefineToolSpec`, `DefineMcpSpec`
- `defineTool`, `defineToolSource`, `defineMcpSource`

### Model contracts

- `ModelSpec`, `ModelClient`, `CompleteArgs`, `CompleteResult`, `ModelStreamEvent`
- `RetryPolicy`
- `MODEL_PRICING`, `ModelPricing`, `estimateCost`
- tier helpers: `isTierAlias`, `inferProvider`, `resolveModelSpec`

### Context and hooks

- `ContextManager`, `CompactionStrategy`, `ContextPrepareContext`
- `DefaultContextManager`, `NoCompactionContextManager`, `AutoCompactionStrategy`
- `Hook`, `HookContext`, `HookResult`, `HookRegistry`
- `buildHookInterceptor`

### Delegation and security helpers

- `DelegationLimits`
- `buildSubagentToolSource`
- `ssrfFetch`
- `validateToolInput`

---

## Store-Owned Contracts (`@render-agents/store`)

Authoritative file: `packages/store/src/index.ts`

### Event model

- `RunEvent`, `RunEventRecord`, `EventCategory`, `EventLogStore`, `EventInterceptor`
- `ContentBlock`, `Message`, `MessageRole`, `ToolResult`, `TokenUsage`

### Run and projection model

- `RunStore`, `RunRecord`, `RunStatus`
- `SpanRecord`, `SpanKind`, `SpanStatus`, `Tracer`
- `ListRunsOptions`, `ListApprovalsOptions`
- `TERMINAL_STATUSES`

### Operational persistence

- `ThreadStore`, `Thread`, `ThreadMessage`
- `ApprovalStore`, `ApprovalRequest`
- `OAuthStore`, `OAuthConnection`, `RefreshedTokens`
- `ScheduleStore`, `ScheduleRecord`

### Queue and streaming

- `JobQueue`, `JobRecord`, `JobKind`, `JobStatus`, `EnqueueOptions`, `FailOptions`
- `DeltaBus`, `StreamDelta`
- `emptyStatusCounts`

### Factories and implementations

- `createStore`, `createJobQueue`, `createDeltaBus`, `createCancelStore`
- memory/pg implementations for store, queue, delta, cancel
- migration/pool helpers

### Utilities

- `idempotencyKey`
- `runRetention`, `reapRuns`, `aggregateRunCost`
- cron helpers (`validateCron`, `matchesCron`, etc.)
- crypto helpers

---

## Gateway Public Surface (`@render-agents/gateway`)

Authoritative file: `packages/gateway/src/index.ts`

- `createGatewayApp`, `startGateway`, `GatewayOptions`
- route builders (`runRoutes`, `streamRoutes`, `threadRoutes`, `hitlRoutes`, `oauthRoutes`, `webhookRoutes`, `uiRoutes`)
- auth middleware (`apiKeyAuth`)
- connector contracts (`ConnectorSpec`, `ConnectorContext`, `loadConnectors`)
- OAuth route contracts (`OAuthProviderConfig`, `OAuthRouteDeps`, `buildRefresher`)
- trace-tree helpers (`buildSpanTree`, `flattenTree`, `perAgentCost`, `formatCost`, `formatDuration`)

---

## Scaffolder Public Surface (`create-render-agents`)

Authoritative file: `packages/create-render-agents/src/index.ts`

- CLI entry: `main`
- `parseArgs`, `optionsFromArgs`, `validateProjectName`
- `buildFileMap`
- `writeProject`
- exported types: `ScaffoldOptions`, `PackageManager`, `Provider`

---

## Stability Guidance

For contract changes, update in this order:

1. source type definitions and exports,
2. tests,
3. this reference file,
4. behavior docs (`01`-`04`, `06`).

This keeps docs aligned to implementation instead of drifting into speculative design.

