# Sprint 13 — HITL Pause & Resume + Idempotency + Cancellation

**Status:** DRAFT
**Wave:** 2 — Orchestration & Durability
**Depends on:** 05 (durable log/projections), 07 (approval gate seam), 11 (dispatch), 12 (`ctx.step` memoization — resume replays completed steps)
**Unblocks:** 16 (cancel route uses `CancelStore`), 18 (gateway HITL routes)

---

## Goal

Implement the human-in-the-loop control-flow signal and its resume-by-replay, finalize tool/dispatch idempotency as a single log-lookup mechanism, and add cooperative cancellation — so a gated tool can pause a run without pinning compute, and the run resumes deterministically with completed work replayed.

---

## Foundational decisions in play

- [D7](../specs/00-foundations.md#d7--hitl-pause-is-a-control-flow-signal-resolved-by-replay) — HITL pause is a control-flow signal resolved by replay; downstream code never runs without a needed result.
- [D3](../specs/00-foundations.md#d3--render-workflows-is-per-task-durable-not-deterministic-replay) — resume re-executes the handler with completed work replayed from storage.
- [D10](../specs/00-foundations.md#d10--the-append-only-event-log-is-the-single-source-of-truth) — idempotency/memoization is "is it already in the log?"

---

## Scope

**In:**
- **Approval state machine** ([Execution → HITL](../specs/02-execution.md#hitl-pause--resume)): `requested` → `pending_approval` → (`denied` | `approved`) → `executed` → `completed`, driven by approval events (`approval.requested`/`approval.resolved`/`approval.auto`).
- **`RunContext.requestApproval` production behavior:** when a gated tool is not pre-approved, emit `approval.requested`, set run status `paused`, and throw **`RunPaused`** carrying pending approval id(s). The catch boundary marks the run paused; in a workflow the signal unwinds the handler. `PausedResult` available to callers that inspect the boundary.
- **In-process approval modes** (finalizing Sprint 04's stub): **auto-approve** (default; emits `approval.auto` + span attribute — auditable, never silent) and **strict** (`RENDER_AGENTS_STRICT_APPROVAL`: TTY `y/n`, or error `approval required, no resolver available` when non-interactive).
- **Approve/deny inline (non-pausing) paths:** approval → continue to dispatch; denial → emit a canonical error `tool_result` and continue (no `tool.called`).
- **Resume-by-replay:** on resume, load folded history (`ctx.messages`), reconstruct approval state from events, re-dispatch approved pending calls through the normal path (idempotency short-circuits already-applied), resolve denied calls as canonical errors, continue from the next iteration.
- **Awaiting-input pause (sibling of approval):** the same pause/resume-by-replay mechanism also supports a run that pauses awaiting **user input** rather than an approval (harness `pauseForAwaitingInput`). New primitive **`RunContext.awaitInput()`** emits **`run.paused { reason: "input" }`** and throws **`RunPaused` (`reason: "input"`, no `pendingApprovalIds`)**; the gateway resumes by **appending a `message.user` event** (Sprint 17/18 `/runs/:id/input`), which the replayed loop folds into `ctx.messages()` so `awaitInput()` returns the new turn. This is the basis for **thread turn-taking** — a thread's active run parks in `awaitInput()` between turns; if the awaiting run was deprovisioned, the thread is revived under a fresh run that rehydrates from the `message.user` history in the log. The pause/resume mechanics are shared with approval; only the **reason discriminator** (`"approval"` vs `"input"`) and the resolving event (`approval.resolved` vs `message.user`) differ.
- **Provider placeholders** are transport-only: a matching `tool_result` block in wire history to satisfy providers, but **not** emitted as canonical `tool.result`, not indexed by idempotency, never counted as applied.
- **Idempotency finalized** ([Execution → Idempotency](../specs/02-execution.md#idempotency)): tool-call key `SHA-256(runId+toolCallId)` via `appliedToolResult`; dispatch key `SHA-256(runId+agentName+callSeq)` via matching `subagent.spawned`/child-run event. One mechanism, two keys; no separate tool-call store.
- **Cancellation** ([Execution → Cancellation](../specs/02-execution.md#cancellation)): `CancelStore` (Postgres `runs.status='cancelled'` poll), checked once per iteration alongside budget; the loop exits cleanly and **appends a terminal `run.cancelled` event** (the authoritative fold). The directly-written `runs.status='cancelled'` flag is a *cancel request* — the one sanctioned control-signal exception to D10's "everything is a projection" (it is not authoritative state; the appended event is). Paused runs cancellable by setting the same flag. KV-backed impl is a future swap.

**Out:**
- The gateway `/approvals` + `/runs/:id/input` HTTP routes + out-of-band resolution UI (Sprint 18) — this sprint provides the runtime mechanics those routes drive.
- Subagent-specific approval gating (`requireApproval: [subagents__x]`) — falls out of the tool gate (Sprint 14 builds the subagent tool atop this).

---

## Deliverables

`@render-agents/engine` + `@render-agents/store`:
- `RunPaused` (with `reason: "approval" | "input"`) throw + catch-boundary handling in the runner/workflow runtime; `PausedResult` surfacing.
- `RunContext.awaitInput()` primitive: emits `run.paused { reason: "input" }`, unwinds via `RunPaused`, returns the next `message.user` content on resume.
- `message.user` event folded into `ctx.messages()` (so delivered turns appear in the resumed/rehydrated history).
- Approval state reconstruction from events; `approval_requests` projection reads (Sprint 03/05).
- Resume orchestration: re-execute → replay completed steps/dispatches/tool-results → continue.
- In-process approval modes (auto/strict).
- `CancelStore` (Postgres) + per-iteration cancel check.
- Idempotency lookups finalized (`appliedToolResult` + dispatch-key check) incl. placeholder exclusion.

---

## Porting source

- **H — HITL approval flow:** `render-agent-harness/.../core/src/loop-steps.ts` (`pauseForApproval`, `replayPendingToolUses`, `pauseForAwaitingInput`) — port pause/resume; adapt to `RunContext.requestApproval()`. The **placeholder `tool_result` trick** and **replay-pending-uses** are critical and must be preserved.
- **H — Idempotent tool dispatch:** `core/src/idempotency.ts` — key kept; check/record becomes a log lookup/emit.
- **H — Cooperative cancellation:** `core/src/cancel.ts` — port the poll pattern; adapt Valkey `cancel:{runId}` to the `CancelStore` interface (Postgres flag for MVP).

---

## Implementation notes

1. **Pause must not pin compute.** The Render task instance is deprovisioned during the pause; from the handler's perspective the `await` simply hasn't returned. On approval, re-execution fast-forwards (steps/dispatches/tool-results replay from the log) to the exact paused point — now with its answer.
2. **Resume is replay, not a bespoke checkpoint.** Everything needed is in the log: folded messages, pending approvals (`requested` w/o `resolved`), started-but-incomplete tool calls (`tool.called` w/o canonical `tool.result`).
3. **Caller never sees partial results** ([D7](../specs/00-foundations.md#d7--hitl-pause-is-a-control-flow-signal-resolved-by-replay)): the paused `await` resolves with the real result or throws `RunPaused`; nothing after it runs on that execution. Validate with the parallel-`Promise.all` example from the spec.
4. **Placeholder discipline** is the subtle correctness point: placeholders satisfy provider wire-format but must be invisible to idempotency/applied-result logic. Tag them so the `tool_calls` fold (Sprint 03) skips them.
5. **Cancellation is cooperative + cheap:** one `runs.status` read per iteration (~5–10ms, negligible vs model latency); no KV dependency required.

---

## Exit criteria / acceptance

- A gated tool with no pre-approval emits `approval.requested`, sets status `paused`, and throws `RunPaused`; the run record shows `paused` with pending approval ids.
- Resolving the approval and re-executing the handler resumes by replay: completed `ctx.step`s/`agent.task()`s/tool-results do not re-run; the previously-paused tool now returns its result; downstream code runs exactly once.
- The spec's parallel example (`security` completes, `performance` pauses) resumes with `security` replayed (not re-run) and `performance` returning its approved result.
- Denied approval yields a canonical error `tool_result` and the loop continues without invoking the tool.
- In-process: auto-approve emits `approval.auto` (+span attr); strict mode prompts on TTY and errors non-interactively.
- A repeated `toolCallId` short-circuits via `appliedToolResult`; provider placeholders never count as applied.
- Cancelling a running or paused run sets status `cancelled` and the loop exits cleanly at the next iteration boundary.

---

## Risks / open questions

- **Re-execution side effects:** any side effect not wrapped in `ctx.step`/`agent.task()` re-runs on resume (the determinism contract from Sprint 12). HITL tests must include side-effecting steps to prove memoization protects them.
- **Approval correlation across subagents:** pending approvals raised inside a dispatched `agent.task()` must surface to the root run's pending list (Sprint 18 lists them) — verify `runId`/approval-id propagation.
- **Provider differences in resume:** some providers are strict about tool_result presence/ordering in history; the placeholder strategy must satisfy both Anthropic and OpenAI wire formats.
- **Cancel vs in-flight model call:** cancellation is checked between iterations; a long in-flight `complete()` only aborts via the signal — ensure `maxWallSeconds`/abort wiring also responds to cancel.
