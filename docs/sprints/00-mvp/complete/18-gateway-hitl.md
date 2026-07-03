# Sprint 18 — Gateway HITL (Approvals API + Resume)

**Status:** DRAFT
**Wave:** 3 — Platform & Serving
**Depends on:** 13 (HITL runtime mechanics), 16 (gateway core)
**Unblocks:** —

---

## Goal

Expose the production HITL surface over HTTP: list pending approvals, resolve them (approve/deny), and resume a paused run via user input — driving the Sprint 13 pause/resume-by-replay mechanics from out-of-band operator actions.

---

## Foundational decisions in play

- [D7](../specs/00-foundations.md#d7--hitl-pause-is-a-control-flow-signal-resolved-by-replay) — a paused run is resolved by an operator out-of-band, then resumed by replay.
- Approvals as event-sourced source of truth from [Platform → Approvals](../specs/03-platform.md#approvals).

---

## Scope

**In:**
- **Routes** ([Platform → Gateway](../specs/03-platform.md#gateway)):
  - `GET /approvals` — list pending approvals (`approval_requests` projection where pending).
  - `POST /approvals/:id/resolve` — approve (`{ approved: true }`) or deny (`{ approved: false, reason }`); emits `input.provided`; triggers run resume.
  - `POST /runs/:id/input` — resume a paused run, **routed by the run's pause reason** ([`run.paused.reason`](../specs/05-type-reference.md#runevent)): for `reason: "input"` (interactive/thread turn) append a **`message.user`** event the parked `awaitInput()` resumes on; for `reason: "approval"` resolve the pending approval. Both then trigger re-execute + replay.
- **`ApprovalStore`** implementation over the `approval_requests` projection/events (`createRequest` is an effect of `input.requested`; `listPending`, `getRequest`, `resolve`).
- **Resume trigger:** resolving an approval re-triggers the workflow run's re-execution (Render Workflows resume / re-dispatch of the root handler), which replays completed work from the log (Sprint 13) and fast-forwards to the paused point.
- **Pending-approval surfacing across the run tree:** approvals raised inside dispatched `agent.task()`/subagents surface to the root run's pending list.
- **Input validation:** pause-reason body matching, valid approval id/state transitions (can't resolve an already-resolved approval), authz via API key.
- **`approval.*` events on the SSE stream** (already flowing from Sprint 17) so the viewer/clients see pending/resolved in real time.

**Out:**
- The approvals UI (Sprint 22 dev viewer shows pending approvals; full operator-UI SPA is post-MVP).
- The core pause/resume *engine* mechanics (Sprint 13) — this sprint is the HTTP/operator surface over them.

---

## Deliverables

`@render-agents/gateway`:
- `/approvals`, `/approvals/:id/resolve`, `/runs/:id/input` routes.
- `ApprovalStore` (interface + impl in `@render-agents/store`) over events/projection; routes in gateway.
- Resume orchestration wiring (resolve → emit `input.provided` → re-trigger run re-execution).
- State-transition validation + clear errors.

---

## Porting source

- **H — HITL approval flow (HTTP side):** `render-agent-harness/.../web/src/routes/*` approval/input routes + `core/src/loop-steps.ts` resume hooks — port the resolve + resume-trigger; adapt to `input.provided` events + Render Workflows re-execution.
- **H — Input validation:** `web/src/routes/*.ts` — pause-reason body matching, agent name resolution.

---

## Implementation notes

1. **Resolution is an event:** `POST /approvals/:id/resolve` emits `input.provided` (with `providedBy`/`reason`); the projection flips to resolved; the run resume is then triggered. Approval state is reconstructed from events on resume (Sprint 13). The input path is symmetric: `POST /runs/:id/input` emits `message.user`, then triggers resume — the parked `awaitInput()` returns the new turn from folded history.
2. **Resume = re-execute + replay:** triggering resume re-runs the workflow handler; Sprint 13's replay ensures completed steps/dispatches/tool-results don't re-run and the paused tool now returns its result.
3. **Idempotent resolution:** resolving an already-resolved approval is rejected (or no-ops idempotently) — don't double-trigger resume.
4. **Cross-tree approvals:** a pending approval inside a child task must appear in `GET /approvals` for the root run; ensure approval ids/run linkage propagate (Sprint 13 risk item).
5. **Cancel a paused run** still works via Sprint 16's cancel route (sets DB status) — document the interaction (cancel vs resolve).

---

## Exit criteria / acceptance

- A run paused by a gated tool appears in `GET /approvals` as pending (including approvals raised in child tasks/subagents).
- `POST /approvals/:id/resolve {approved:true}` resumes the run; it completes with the tool's real result and no duplicated side effects.
- `{approved:false, reason}` resolves as denied; the run continues with a canonical error `tool_result`.
- `POST /runs/:id/input` on a run paused with `reason: "input"` appends a `message.user` event and resumes the run, which continues with the new turn in its folded history.
- Resolving an already-resolved approval is rejected; invalid ids → 404; unauthenticated → 401.
- `input.requested`/`input.provided` events appear on the run's SSE stream.

---

## Risks / open questions

- **Resume trigger mechanism on Render Workflows:** confirm how a paused root handler is re-executed (explicit re-dispatch vs a resume API); the replay correctness depends on Sprint 13 + 11/12 semantics.
- **Race: resolve while still pausing:** an approval resolved before the pause is fully durable — ensure ordering (pause/`input.requested` committed before resolution is accepted).
- **Multiple pending approvals in one run:** resolve-all vs one-at-a-time resume; define whether resume waits for all pending or resumes per-resolution (recommend resume re-executes and re-pauses on the next still-pending gate).
