import { RunPaused } from "./agent.js";

/**
 * A run's pause point. The `Suspender` owns *how* a run parks awaiting an
 * out-of-band resolution and how it is woken. The two realizations mirror the
 * dispatcher split (`InProcessDispatcher` vs `RenderWorkflowsDispatcher`):
 *
 * - `ReplaySuspender` (in-process / local dev / Lane B chat): park = throw
 *   `RunPaused` to unwind the handler so no compute is pinned; wake = the run is
 *   re-executed and the now-resolved gate short-circuits from the event log
 *   (resume-by-replay). This is the historical behavior, now behind the seam.
 * - `NativeWorkflowsSuspender` (Lane A on Render Workflows): park = `await` the
 *   platform's durable suspension keyed by a resume token; wake = an external
 *   POST to the run's resume endpoint delivers the resolution and the awaited
 *   call returns — no handler re-execution, no determinism contract.
 *
 * In both modes the caller emits `input.requested` + `run.paused` *before*
 * parking, so the operator UI, projections, and channel delivery observe the
 * pause regardless of the suspension mechanism. Only the control flow differs.
 */
export interface SuspendRequest {
  /** The run being parked. */
  runId: string;
  /** Deterministic id of the input request whose resolution resumes the run. */
  inputRequestId: string;
  /** What kind of resolution unblocks it — an approval decision or a user message. */
  kind: "approval" | "message";
}

export interface Suspender {
  /**
   * Park `req.runId` until `req.inputRequestId` is resolved out of band.
   *
   * Resolves (`void`) only on the *wake* path of a continuation-preserving
   * suspender (native): the caller then re-reads the resolution from the log and
   * returns it. `ReplaySuspender` never resolves — it throws `RunPaused` to
   * unwind, and resolution is delivered by the run's later re-execution.
   */
  park(req: SuspendRequest): Promise<void>;
}

/**
 * In-process realization: parking throws `RunPaused`, unwinding the handler so
 * the pause pins no compute; the run is later re-executed (resume-by-replay) and
 * the resolved gate short-circuits from the event log.
 */
export class ReplaySuspender implements Suspender {
  async park(req: SuspendRequest): Promise<void> {
    throw new RunPaused(req.runId, "input", [req.inputRequestId]);
  }
}

/** Shared default so callers need not construct one per run (it is stateless). */
export const replaySuspender: Suspender = new ReplaySuspender();
