# Sprint 11 — Render Workflows Dispatch (`agent.task()`)

**Status:** DRAFT
**Wave:** 2 — Orchestration & Durability
**Depends on:** 04 (runtime + `.task()` fallback), 05 (durable store)
**Unblocks:** 12 (workflows), 13 (HITL across tasks), 14 (subagents)

---

## Goal

Make `agent.task()` real: auto-register a bounded set of plan-tier dispatch tasks on Render Workflows, dispatch agent runs as isolated chained tasks with deterministic idempotency keys, and keep the transparent in-process fallback for local/test. This turns the Wave-0 `.task()===.run()` fallback into genuine container isolation in production.

---

## Foundational decisions in play

- [D2](../specs/00-foundations.md#d2--one-execution-model-run-vs-task-is-a-method-call-not-config) — `run` vs `task` is a call site; same definition, same output shape.
- [D3](../specs/00-foundations.md#d3--render-workflows-is-per-task-durable-not-deterministic-replay) — per-task durability; retry = full re-run; no memoized replay.

---

## Scope

**In:**
- **`TaskDispatcher`** implementation over `@renderinc/sdk/workflows`: the Render Workflows dispatcher selected when `RENDER_SDK_SOCKET_PATH`/`RENDER_USE_LOCAL_DEV` are present (completes the Sprint 04 `createRuntime` dispatcher seam).
- **Bounded plan-tier task registration** at workflow-service startup: one generic `agent@<plan>` task per `RenderPlan` referenced across loaded agents (plus default `standard`). `pro_plus`/`pro_max`/`pro_ultra` only registrable with workspace access.
- **`agentTaskHandler(agentName, input, dispatchMeta)`**: reloads the agent from the deployed image **by name** (only `input` is serialized; definitions are re-loaded, never shipped) and runs it through the `DefaultRunner`.
- **`agent.task(input)` resolution + dispatch:** resolve effective `plan` from frontmatter (or default), dispatch `(agentName, input)` to the matching `agent@<plan>` task:
  - inside a workflow handler → call the registered task fn directly (durable chained run, returns a promise);
  - from gateway/outside → Render client `workflows.runTask(id, input)` / `startTask` + `result.get()`;
  - no workflow server → in-process `.run()` fallback.
- **Deterministic dispatch key** `SHA-256(runId + agentName + callSeq)` on `DispatchOptions`; on handler re-execution, re-dispatch returns the existing child run's result (idempotent) — the memoization mechanism (matching `subagent.spawned`/child-run event) is the Sprint 03/13 log lookup.
- **JSON-serializability enforcement:** non-serializable task input/output throws at dispatch time.
- **Identity propagation:** `userId`, `parentSpanId`, `depth` flow via `DispatchOptions` to the child run (so spans nest and OAuth identity carries).

**Out:**
- The `workflow()` helper + `ctx.step` + determinism contract (Sprint 12) — this sprint dispatches *agents* as tasks; workflows-as-root-tasks is next.
- HITL pause across a dispatched task (Sprint 13) — the dispatch path is built here; pause/resume semantics layer on.
- Subagent delegation (Sprint 14) — reuses this dispatcher.

---

## Deliverables

`@render-agents/sdk` (+ a workflow-service registration entrypoint):
- `TaskDispatcher` over Render Workflows + the in-process fallback dispatcher.
- Startup registration of `agent@<plan>` tasks (bounded by referenced plans).
- `agentTaskHandler` (reload-by-name + run).
- Dispatch-key computation + idempotent re-dispatch via log lookup.
- `createRuntime` dispatcher auto-detection finalized.

---

## Porting source

- **T — Task dispatch:** *new*, wraps `@renderinc/sdk/workflows` ([Porting Map](../specs/porting-map.md#1-from-agent-workflows-template-orchestration-kernel)). No harness equivalent (the harness used four runtime adapters + pg-boss, both intentionally dropped — [§3](../specs/porting-map.md#3-not-ported-intentionally-dropped)).
- Reference Render Workflows SDK docs for `task()` definition, `runTask`/`startTask`, chained runs, retry/timeout options, and the local-dev socket env vars.

---

## Implementation notes

1. **Compute is bound at definition time.** Render binds the instance type to a task when it's defined; the run-trigger API takes only task+input. Hence the **one-task-per-referenced-plan** registration — `agent.task()` picks the matching `agent@<plan>`. Document that arbitrary per-run cpu/mem is not available.
2. **Reload, don't ship.** The handler reloads the agent definition from the deployed image by name; only `input` crosses the wire. This keeps definitions canonical (markdown in the image) and inputs small.
3. **`callSeq` is the per-handler dispatch ordinal** — it requires deterministic control flow in the caller (enforced by the Sprint 12 determinism contract). The key dedupes re-dispatch on re-execution.
4. **Fallback parity:** with no workflow server, `.task()` runs as `.run()` with identical events/projections/output — the only difference is container isolation + retries (the Wave-0 invariant must still hold).
5. **Span correlation across containers:** propagate `runId`/`parentSpanId` so the child task's spans nest under the caller in the trace tree (Sprint 10's tree must survive the process boundary).

---

## Exit criteria / acceptance

- In a deployed (or local-dev workflows) environment, `agent.task(input)` runs the agent in its own container on its frontmatter `plan` and returns the same `AgentOutput` shape as `.run()`.
- Exactly one `agent@<plan>` task is registered per referenced plan (+`standard`); an agent referencing `pro_max` without access fails clearly at registration.
- Re-executing a handler re-dispatches a completed `agent.task()` and gets the **existing** child run's result (no duplicate run), proven via the dispatch-key log lookup.
- Non-serializable input throws at dispatch.
- `userId`/`parentSpanId`/`depth` propagate; child spans nest under the parent in `listSpans`.
- With no workflow server, `.task()` falls back to `.run()` with identical observable behavior.

---

## Risks / open questions

- **Render Workflows SDK surface stability:** `@renderinc/sdk/workflows` API (task def, chained runs, `runTask`) must be confirmed against the current SDK version; pin it.
- **Plan access gating:** detecting workspace access for `pro_*` plans at registration vs deploy — may need a clear failure mode and docs.
- **Cold-reload cost:** reloading the agent definition per task invocation — cache the loaded `AgentSet` per container process to avoid re-parsing on every dispatch.
- **Idempotent re-dispatch correctness** depends on the child-run/`subagent.spawned` event being durably recorded *before* the result is consumed; verify ordering with Sprint 13's resume tests.
