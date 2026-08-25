import type { Suspender, SuspendRequest } from "@render-factory/engine";

/**
 * Lane A (Render Workflows) realization of the `Suspender`: parking `await`s the
 * platform's native durable suspension keyed by a resume token, and an external
 * POST to the run's resume endpoint wakes the awaited call with the resolution.
 * Unlike `ReplaySuspender` it preserves the handler continuation, so resume
 * needs no re-execution and imposes no determinism contract on workflow authors.
 *
 * PENDING PLATFORM API: Render Workflows native pause/resume is not yet
 * available. Once it is, `park` should:
 *   1. mint (or read) a resume token for `req.inputRequestId`,
 *   2. persist it on the `input.requested` record so the gateway can address it,
 *   3. `await` the platform's durable "wait for token" primitive, returning when
 *      the resolution is delivered (the caller re-reads it from the event log).
 * The matching resume trigger lives on the dispatcher
 * (`TaskDispatcher.resumeSuspension`), which the gateway calls instead of
 * re-driving.
 *
 * Until wired, this is defined but NOT selected by `createRuntime` (the runtime
 * falls back to `ReplaySuspender`); constructing and using it throws loudly so a
 * premature switch is obvious rather than silently hanging.
 */
export class NativeWorkflowsSuspender implements Suspender {
  async park(_req: SuspendRequest): Promise<void> {
    throw new Error(
      "NativeWorkflowsSuspender.park: Render Workflows native pause/resume API " +
        "is not yet available. Use the default ReplaySuspender until it lands.",
    );
  }
}
