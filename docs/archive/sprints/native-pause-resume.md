# Native Workflows Pause/Resume — design note & pickup

**Status:** SEAM LANDED · NATIVE IMPL PAUSED (blocked on the Render Workflows platform API)
**Date:** 2026-07-04

Render Workflows will add a **native durable pause/resume** mechanism triggered by
hitting a **webhook/endpoint**. Native suspension preserves the handler
continuation, so it retires resume-by-replay (and its determinism contract) for
Lane A — superseding [D7](../specs/00-foundations.md#d7--hitl-pause-is-a-control-flow-signal-resolved-by-replay)
for the workflow lane. This note captures the seam we landed now and the exact
work left for when the platform API ships.

---

## The model shift

| | Today (replay) | Native (webhook/endpoint) |
|---|---|---|
| Pause | throw `RunPaused` → unwind → record `run.paused` → container exits | handler `await`s a durable suspension; compute deprovisioned, continuation preserved |
| Resume | re-trigger (`dispatchRoot`) → re-execute → replay memoized steps | external **POST to the run's resume endpoint** wakes the parked `await` |
| Get the answer in | re-read `input.provided`/`message.user` from the log on replay | same — resolution is in the log; the wake just lets the `await` return |

In **both** modes the caller still emits `input.requested` + `run.paused` before
parking, so the operator UI, projections, and channel delivery are unchanged.
Only the control flow differs.

---

## What's landed (the seam — done, tested, behavior-preserving)

- **`Suspender` seam** — `packages/engine/src/suspender.ts`: `Suspender.park()`,
  `ReplaySuspender` (default: emit-then-throw `RunPaused`), `replaySuspender`.
- **`InProcessRunContext`** (`packages/engine/src/run-context.ts`):
  `requestInput` (approval) and `awaitInput` (message) emit `input.requested` +
  `run.paused`, then `park()` through the injected suspender. Replay throws; a
  continuation-preserving suspender returns inline and the decision is re-read
  from the log.
- **Plumbing** — optional `suspender` flows `RunInProcessDeps` →
  `AgentRuntime`/`CreateRuntimeOptions` → `InProcessDispatcher`/`agentTaskHandler`
  (defaults to replay when unset).
- **Dispatcher seam** (`packages/sdk/src/runtime.ts`): optional
  `TaskDispatcher.supportsNativeSuspension` + `resumeSuspension({ runId, token, payload? })`.
- **`NativeWorkflowsSuspender` skeleton** (`packages/sdk/src/native-suspender.ts`)
  — defined but **not** selected by `createRuntime` (throws if used).
- **Tests** — `packages/engine/tests/suspender.test.ts` proves both the
  replay-throw path and the native inline-return path (via a fake
  continuation-preserving suspender).

Replay remains the default everywhere; nothing is behavior-changed, and no path
is half-wired.

---

## The two platform bind points (all that's actually blocked)

1. **Suspend** — `NativeWorkflowsSuspender.park(req)`
   (`packages/sdk/src/native-suspender.ts`): call the platform "suspend until
   resumed" primitive keyed by `req.inputRequestId`; return on wake. The caller
   re-reads `input.provided` from the log.
2. **Resume** — `RenderWorkflowsDispatcher.resumeSuspension({ runId, token })`
   (`packages/sdk/src/dispatch.ts`): trigger the platform resume webhook/endpoint
   for that suspended run/task. `token` is the `inputRequestId`.

---

## Remaining finish steps (when the API ships)

- Implement the two bind points above.
- `createRuntime`: select `NativeWorkflowsSuspender` + set the dispatcher's
  `supportsNativeSuspension` when native is available (env-gated, e.g.
  `RENDER_FACTORY_NATIVE_SUSPENSION`).
- Gateway `resume` closure (`packages/gateway/src/app.ts`): when
  `dispatcher.supportsNativeSuspension`, wake the run's pending inputs via
  `resumeSuspension({ runId, token: inputRequestId })` instead of `redriveRoot`;
  drop `findPausedWorkflowRoot` for the native path (a child's own `await` is the
  suspension point, so resume is addressed to the run that owns the pending input).
- Tests: gateway native-resume routing (mock dispatcher with `supportsNativeSuspension`).
- Docs: update [`02-execution.md`](../specs/02-execution.md) HITL section and
  supersede D7 for Lane A in [`00-foundations.md`](../specs/00-foundations.md).

---

## Open questions (platform-API-dependent)

- **Token minting** — platform-issued (persist on `input.requested`) vs.
  app-supplied deterministic id (`runId` + `inputRequestId`, no persistence)?
- **Addressing** — resume by our `runId`, or a platform `taskRunId` we must
  persist at dispatch time (`dispatchRoot`/`startTask` currently discards it)?
- **Continuation fidelity** — full locals preserved, or only the `await` point?
- **Lifecycle** — max suspension duration/cost; cancel-during-suspension
  semantics (platform cancel vs. resuming into a cancel path).
- **Payload** — does the resume POST deliver a body into the `await`, and its
  size/JSON limits (mirrors `assertSerializable`)?
- **Security** — signed / single-use / TTL'd resume tokens if the endpoint is
  externally reachable (fits the existing `WebhookVerify` culture).
