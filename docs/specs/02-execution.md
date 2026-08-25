# Execution

**Status:** IMPLEMENTED (living)
**Date:** 2026-07-02
**Layer:** L2 - runtime behavior.

This layer describes how runs execute today across SDK, engine, and store.

---

## Runtime Composition

`createRuntime()` (`packages/sdk/src/runtime.ts`) is the composition root.

Auto-detected defaults:

- **Store:** Postgres if `DATABASE_URL` exists, else memory.
- **Model:** inferred from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, else unconfigured placeholder.
- **Dispatcher:** Render Workflows dispatcher when Render env signals are present; otherwise in-process dispatcher.
- **Queue/Delta/Cancel:** derived from store backend via `createJobQueue`, `createDeltaBus`, `createCancelStore`.
- **Execution mode:** `inline` by default, or `queue` when `RENDER_FACTORY_EXECUTION_MODE=queue`.

Runtime includes: `store`, `threadStore`, `oauthStore`, `scheduleStore`, `runners`, `hooks`, `dispatcher`, `jobQueue`, `deltaBus`, `cancelStore`, and loaded registries for agents/workflows/tool sources.

---

## Root Execution Lanes

### Lane A: durable workflow roots

- Started by `workflow.dispatch(...)`.
- Gateway records `run.started`, then triggers root execution via `dispatchRoot`.
- In production this is `RenderWorkflowsDispatcher.startTask("workflow@<plan>")`.
- In local fallback, root can be driven in-process.

### Lane B: interactive chat turns

- Each user message is a new run in the thread.
- `submitRootRun` either:
  - drives inline (`executionMode=inline`), or
  - enqueues a durable `run_jobs` entry (`executionMode=queue`) for `runWorker`.

`run_jobs` kinds are `agent` and `resume` only.

---

## `run` vs `task`

Both methods use the same `AgentDefinition` and output shape:

- `agent.run(input)` -> in-process execution.
- `agent.task(input)` -> dispatcher path (Render task or in-process dispatcher fallback).

Child run IDs are deterministic in workflow context (`idempotencyKey`-based) so replay does not duplicate child work.

---

## Default Runner Loop

`DefaultRunner` (`packages/engine/src/default-runner.ts`) executes:

1. mount tools (including `subagents__*` tools; add `load_skill` if skills declared),
2. emit opening events (`run.started`, `message.user`) unless resuming,
3. iterate with budget and cancellation checks,
4. load model-visible history through `ctx.messages()` (includes context compaction),
5. replay pending tool calls if latest assistant turn contains unresolved `tool_use`,
6. call model, emit `llm.call` + `message.assistant`,
7. dispatch tools sequentially when requested,
8. complete when no `tool_use` remains (`run.completed`).

Terminal-turn detection is based on content (`tool_use` presence), not provider stop reason.

---

## Tool Dispatch Pipeline

For each tool call:

1. idempotency lookup (`ctx.appliedToolResult`),
2. input gate (`ctx.requestInput`) if required,
3. tool lookup by mounted name,
4. input schema validation,
5. emit `tool.called`,
6. invoke tool,
7. emit `tool.result`.

Behavior details:

- Tool errors are returned to model as `tool_result` with `isError`.
- Event-interceptor veto (`EventRejectedError`) on `tool.called` is converted to recoverable tool error, not run crash.
- `RunPaused` and `RunCancelled` are propagated as control-flow signals.

---

## HITL Pause and Resume

Pauses happen via `RunPaused` and logged `run.paused` with reason `input`.
`run.paused.pendingInputIds` identifies the unresolved request(s), and each
request carries a kind (`approval` or `message`) on `input.requested`.

Resume model:

- Resolve event appended (`input.provided` or `message.user`),
- run is re-driven with same `runId`,
- idempotency + event replay reconstruct state.

Approval-kind input behavior in `InProcessRunContext`:

- default dev/test: auto-approve (emits `input.auto`),
- strict mode: prompt on TTY or pause in non-interactive environments.
- in production (`NODE_ENV=production`), strict behavior is fail-safe unless explicitly disabled.

---

## Determinism and Replay

Workflow handlers (`packages/sdk/src/workflow.ts`) are replay-safe when authors follow:

- all side effects in `ctx.step`,
- deterministic control flow,
- agent fan-out via `ctx.agents`.

Mechanisms:

- `step.completed` memoization by `(runId, stepName)`,
- deterministic child run IDs,
- child output memoization through reserved `__task_output__` step.

---

## Cancellation

Cancellation is cooperative:

- gateway requests cancel (`cancelStore.requestCancel`),
- loops poll `ctx.isCancelled()` at iteration boundaries and during streaming,
- terminal event emitted as `run.cancelled`.

Cancel-scope propagation is supported for descendant runs (`cancelScopeId`).

---

## Context Management

History is prepared by `ContextManager` before each model call.

Default behavior (`DefaultContextManager`):

- estimate token use,
- compact when over threshold,
- keep recent turns, summarize older turns, truncate large historical tool output,
- emit `context.compacted`.

Current defaults:

- run context default `maxContextTokens` is `100_000`,
- model-window-derived threshold helper exists but is not the default path unless provided.

Current gap:

- frontmatter `context.compaction` is parsed but not used to switch strategy per-agent.

---

## Structured Output

When agent defines `output` schema:

- runner validates terminal assistant text as JSON against schema,
- if invalid, performs up to 3 corrective model calls with schema response format,
- returns structured data in `AgentOutput.data`,
- errors if schema-conformant output cannot be produced.

Agents without `output` return text-only output.

---

## Worker and Queue Semantics

`runWorker` (`packages/sdk/src/worker.ts`) processes queue jobs:

- `agent` -> `driveAgentTurn`,
- `resume` -> `resumeRun`.

A job is completed when run reaches resting state (`completed`, `failed`, `cancelled`, or `paused`).
Requeue is only for interrupted/non-settled execution paths, bounded by delivery budget (`maxAttempts`).

