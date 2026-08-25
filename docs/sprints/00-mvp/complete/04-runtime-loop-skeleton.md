# Sprint 04 — Runtime Composition + Default Loop Skeleton

**Status:** DRAFT
**Wave:** 0 — Foundations & Walking Skeleton
**Depends on:** 02 (authoring), 03 (event log)
**Unblocks:** all of Wave 1

---

## Goal

Wire the composition root (`createRuntime`/`AgentRuntime`), bind agents to it (`loadAgents` step 9), and implement the `DefaultRunner` agent loop against the in-memory event log and a mock model — closing the Wave 0 walking skeleton so `loadAgents().get("x").run(input)` executes end-to-end, fully event-sourced, with passing tests. Also lands the testing utilities (`mockModel`, `createTestRuntime`).

---

## Foundational decisions in play

- [D2](../specs/00-foundations.md#d2--one-execution-model-run-vs-task-is-a-method-call-not-config) — `agent.run()` runs in-process; same definition, same output shape (`.task()` falls back to `.run()` until Sprint 11).
- [D5](../specs/00-foundations.md#d5--injectable-runtime--composition-root) — one `AgentRuntime` built by `createRuntime()`, bound via `loadAgents`; no global singleton.
- [D9](../specs/00-foundations.md#d9--the-runner-is-pluggable-runcontext-is-the-full-platform-contract) — the loop is an interface; `RunContext` is the platform contract the runner consumes.
- [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) — every persisting step is an `emit` to the log.

---

## Scope

**In:**
- **`createRuntime(opts?)`** with env auto-detection per [Execution → Runtime & composition](../specs/02-execution.md#runtime--composition): store (in-memory in Wave 0; Postgres-detection wired in Sprint 05), model client (provided/mock here; real clients Sprint 06), runner registry (`default` → `DefaultRunner` + `runners/` adapters), dispatcher (absent → in-process fallback), `contextManager` (pass-through default until Sprint 09), `hooks` (empty registry until Sprint 15; the store's `EventInterceptor` seam is left unset — no interceptor injected yet).
- **`AgentRuntime`** object assembled from those dependencies.
- **`loadAgents` step 9 (binding):** every `Agent` closes over the runtime; `agent.run()`/`agent.task()` know their model/store/tracer/runner/dispatcher with no per-call wiring. `.task()` transparently calls `.run()` when no dispatcher is present.
- **`RunContext` implementation** (the in-process realization): `emit` (→ `events.append`), `messages(agentName)` (→ folded history), `appliedToolResult` (→ idempotency lookup), `requestApproval` (auto-approve default mode + `input.auto` event; strict-mode TTY prompt stub — full HITL is Sprint 13), `mountTools` (stub returning declared tools — real mounting Sprint 07), `isCancelled` (memory flag — real cancellation Sprint 13), `signal`/`logger`/`tracer`/`runId`/`parentSpanId`/`userId`/`depth`/`env`.
- **`DefaultRunner`** implementing the [agent loop](../specs/02-execution.md#the-agent-loop): the ITERATE cycle (cancellation check, budget check stubs, abort check, [context prepare hook — pass-through], model call → `emit llm.call`, `emit message.assistant`, end_turn return, per-`tool_use` dispatch with `emit tool.called`/`tool.result`, `emit message.tool`). Wave 0 scope: real iterate/call/dispatch + event emission; **deep** budget/cost/structured-output/skills/compaction/HITL/idempotency are stubbed or minimal and filled in Wave 1+.
- **`Agent.run<T>()`** returning `AgentOutput<T>` (text now; `data` once structured output lands in Sprint 08).
- **Testing utilities** (`@render-factory/sdk/testing`): `mockModel(handler)` (programmable `ModelClient`) and `createTestRuntime(opts?)` (memory store, mock/provided model, no dispatcher).
- **Lifecycle events:** `run.started` / `run.completed` / `run.failed` emitted around the loop; run status projection reflects them.

**Out:**
- Real model providers (Sprint 06) — Wave 0 uses `mockModel`.
- Real tool mounting/MCP/dispatch sequence (Sprint 07) — loop dispatches against an injected flat tool map.
- Budgets enforcement detail, structured output, skill loading (Sprint 08).
- Context compaction (Sprint 09); tracing as projection polish (Sprint 10); workflows/tasks (Sprint 11+); HITL pause/resume + idempotency short-circuit + cancellation store (Sprint 13).

---

## Deliverables

- `createRuntime` + `AgentRuntime` assembly in `@render-factory/sdk` (env detection seams present, defaults to memory/in-process).
- `loadAgents` runtime binding (completes Sprint 02's pipeline at step 9).
- `DefaultRunner` in `@render-factory/engine` (re-exported via sdk).
- `RunContext` in-process implementation.
- `Agent` handle (`run`/`task`) bound to the runtime.
- `mockModel` + `createTestRuntime` in `@render-factory/sdk/testing`.

---

## Porting source

- **T — LLM loop:** `agent-workflows-template/src/engine/loop.ts` — port the iterate/call/dispatch structure (already clean). **Replace** ad-hoc message accumulation + the bespoke tracer with `ctx.emit(...)` events (D10); drop the `allowedTools`/`deniedTools` permission filter (replaced by `tools[]` allowlist); keep `end_turn` detection, `tool_use` extraction, error-contained dispatch, and abort checks. The template's `RunLoopArgs`/`RunLoopResult` become `(AgentDefinition, AgentInput, RunContext)` → `AgentOutput`.
- **T — Agent handle:** `agent-workflows-template/src/engine/agent.ts` (`makeAgentTask`) — adapt to `Agent` with both `run()` and `task()`; bind to `AgentRuntime` instead of capturing dirs.
- **T — Runtime/composition root:** *new* (no direct source) per [Porting Map](../specs/porting-map.md#1-from-agent-workflows-template-orchestration-kernel).

---

## Implementation notes

1. **The loop talks only to `RunContext`.** No direct store/tracer calls — everything is `ctx.emit`, `ctx.messages`, `ctx.appliedToolResult`, `ctx.requestApproval`, `ctx.isCancelled`. This is what makes the runner pluggable (D9) and keeps Wave 1 additions localized to the context/store, not the loop body.
2. **Build `RunContext` once per run**, carrying `runId`, `parentSpanId`, `userId`, `depth`. The agent span is opened on `run.started`; LLM/tool spans nest via emitted span-producing events (the `spans` projection from Sprint 03 assembles the tree).
3. **Stub the Wave-1 hooks explicitly** (budget = defaults only; context.prepare = identity; requestApproval = auto-approve + `input.auto`; mountTools = passthrough) and leave TODO markers tied to their sprints so the seams are obvious and tested-around.
4. **`.task()` fallback:** when `runtime.dispatcher` is undefined, `task()` delegates to `run()` (local-dev/testing parity). Real dispatch is Sprint 11.
5. **Testing parity:** `createTestRuntime` must run the *real* `DefaultRunner` — only the model and store are swapped. The example from [Authoring → Testing](../specs/01-authoring.md#authoring-api) must pass verbatim.

---

## Exit criteria / acceptance

- The [Authoring → Testing](../specs/01-authoring.md#authoring-api) example runs green: `mockModel` returning a JSON text block → `loadAgents` against a fixture → `agents.get("judge").run(...)` resolves with text (and the run is fully event-sourced).
- A run with a mock tool-use loop emits the correct event sequence (`run.started` → `llm.call` → `message.assistant` → `tool.called` → `tool.result` → `message.tool` → … → `run.completed`) and the projections reflect it.
- `agent.task(input)` with no dispatcher produces identical output to `agent.run(input)`.
- The agent/LLM/tool span tree is correct via the `spans` projection.
- `createRuntime()` with no env returns a memory-store, in-process-fallback runtime; with an injected model/store it uses those.

---

## Risks / open questions

- **Scope discipline:** the loop will be revisited by nearly every Wave 1 sprint. Keep the body small and push behavior into `RunContext`/store so later sprints don't rewrite the loop.
- **`mountTools` placeholder vs allowlist:** Wave 0 passes a flat tool list; ensure the placeholder still honors `tools[]` as the presented set so behavior doesn't change when real mounting lands (Sprint 07).
- **Event ordering under async tool dispatch:** Wave 0 dispatches tools sequentially (matches spec; parallel is a future optimization) — keep it sequential so `seq` ordering is deterministic.
