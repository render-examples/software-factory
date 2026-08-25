# Sprint 12 — Workflows + Determinism (`workflow()`, `ctx.step`)

**Status:** DRAFT
**Wave:** 2 — Orchestration & Durability
**Depends on:** 11 (task dispatch)
**Unblocks:** 13 (resume replays completed `ctx.step`s), 16 (gateway dispatches workflows), 20 (triggers)

---

## Goal

Implement the composition layer: the `workflow()` helper that binds a handler into a Render Workflows root task, the run-scoped `WorkflowContext` (including `ctx.agents` and `ctx.step` memoization), and the determinism contract (`retries=0` default, side effects in `ctx.step` or `agent.task()`).

---

## Foundational decisions in play

- [D3](../specs/00-foundations.md#d3--render-workflows-is-per-task-durable-not-deterministic-replay) — per-task durable; root handler `retries` default to 0; determinism is the author's contract.
- [D4](../specs/00-foundations.md#d4--workflows-orchestrate-postgres-persists) — Workflows answer "what runs next?"; Postgres holds the log; resume is driven from the log.
- [D5](../specs/00-foundations.md#d5--injectable-runtime--composition-root) — inside a handler, agents are accessed via the run-scoped `ctx.agents`, not a module-level `loadAgents()` closure.

---

## Scope

**In:**
- **`workflow(opts?, handler)`** ([Type Reference](../specs/05-type-reference.md#workflow)): both overloads (with config / handler-only with name inferred from directory). Discovery from `workflows/<dir>/index.ts` (key = dir name), validated for collisions in Sprint 02.
- **Workflow-as-root-task registration** on Render Workflows: the handler *is* the root task; `retries` default 0; `timeout`/`plan` from `WorkflowOptions`.
- **`WorkflowContext`** ([Type Reference](../specs/05-type-reference.md#workflowcontext)): `runId`, `trigger`, `input`, **`agents` (run-scoped `AgentSet`)**, `tracer`, `logger`, `signal`, `userId`, and **`step<T>(name, fn)`**.
- **`ctx.agents` run-scoping:** a view of the project `AgentSet` bound to *this* run (carries run id, tracer, parent span) so spans nest and dispatch/idempotency keys are correct. This is the only in-handler way to access agents.
- **`ctx.step(name, fn)` memoization:** result persisted by `(runId, name)` via `step.started`/`step.completed` events → `workflow_steps` projection (Sprint 03/05). On re-execution, completed steps short-circuit to the stored result; plain calls re-run. Unique step names enforced.
- **Determinism contract (documented + guardrails):** handler control flow must be deterministic; side effects/non-determinism (wall-clock, randomness, external mutable state) must be wrapped in `ctx.step()` or performed inside `agent.task()`. `retries=0` so a failed handler isn't blindly re-run.
- **`WorkflowDefinition.dispatch(input, trigger?)`** → creates a run (`run.started`) and triggers the root task; returns the `RunRecord`.

**Out:**
- HITL resume re-execution mechanics (Sprint 13) — this sprint provides `ctx.step` replay-on-re-execution, which Sprint 13's pause/resume relies on; the *pause* itself is Sprint 13.
- The gateway `POST /workflows/:name` route (Sprint 16) — `dispatch` is callable here; the HTTP surface is later.
- Cron/webhook triggers (Sprint 20).

---

## Deliverables

`@render-factory/sdk`:
- `workflow()` helper + `WorkflowDefinition` + discovery loader for `workflows/`.
- Root-task registration on Render Workflows (`retries=0` default).
- `WorkflowContext` impl incl. run-scoped `ctx.agents` and `ctx.step` memoization (events → `workflow_steps`).
- Determinism guardrails + author-facing docs/lints where feasible.

---

## Porting source

- **T — Workflow handler + `ctx.step`:** `agent-workflows-template/src/workflows/code-review/index.ts`, `src/workflows/loader.ts`, `src/workflow.ts` — adapt: add `ctx.step()` memoization (`step.completed` → `workflow_steps`), `retries=0` default, the determinism contract. The code-review pipeline becomes the scaffolder's default example (Sprint 21).
- **T — Workflow composition reference:** the existing `content-pipeline`/`lead-enrichment` workflows show multi-step + parallel patterns to validate the `ctx.agents`/`ctx.step`/`Promise.all` ergonomics.

---

## Implementation notes

1. **`ctx.agents` is the single in-handler path.** A module-level `loadAgents()` closure used inside a handler is not run-scoped and mis-correlates traces — document this loudly and, if feasible, lint against it. The gateway/workflow service call `loadAgents()` once at startup; the runtime exposes the run-scoped view per run.
2. **`ctx.step` is the determinism escape hatch.** Memoize by `(runId, name)`; on re-execution return the stored result without running `fn`. Step names unique per workflow (collision = error).
3. **`retries=0` is deliberate** ([D3](../specs/00-foundations.md#d3--render-workflows-is-per-task-durable-not-deterministic-replay)): durability/resumption come from child `agent.task()` runs + the event log (replayed via step memoization + dispatch keys), not blind handler re-runs.
4. **Determinism depends on stable control flow** because `ctx.step` names and `agent.task()` `callSeq` ordinals are positional. Wrap wall-clock/random/external reads in `ctx.step`.
5. **Worked example parity:** the [Determinism & replay example](../specs/02-execution.md#determinism--replay) (`prepare-diff` step → parallel `task()` → `judge.run()` → `post-review` step) must run and replay correctly.

---

## Exit criteria / acceptance

- A `workflows/<dir>/index.ts` exporting `workflow(handler)` is discovered with name = dir; `dispatch(input)` triggers a root-task run and returns a `RunRecord`.
- `ctx.step("x", fn)` runs `fn` once; on a forced handler re-execution the stored result is returned and `fn` does not re-run (verified via a side-effect counter).
- Re-execution replays completed `ctx.step`s and completed `agent.task()` dispatches; only the unfinished work runs.
- Duplicate `ctx.step` names error; non-deterministic control flow producing a different `callSeq` is detectable in tests.
- The spec's determinism example workflow runs end-to-end and replays correctly.

---

## Risks / open questions

- **Detecting non-determinism:** there's no general runtime guard against a handler that branches on wall-clock/random; rely on docs + optional lint + the `ctx.step` discipline. Consider a dev-mode warning when `Date.now()`/`Math.random()` are called in a handler frame.
- **Root-task retry semantics:** confirm Render Workflows honors `retries=0` as "mark failed, don't re-run"; reconcile with how chained child tasks retry independently.
- **`ctx.agents` run-scoping plumbing:** ensure the run-scoped AgentSet view cheaply rebinds tracer/parent-span without re-parsing agents per run (reuse the startup `AgentSet`, wrap with run context).
