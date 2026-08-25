import type { JobKind } from "@render-factory/store";
import type { AgentRuntime } from "./runtime.js";

/**
 * Chat-lane priority (lower = claimed first). A `resume` unblocks a human who is
 * already waiting mid-conversation (HITL), so it preempts fresh `agent` turns.
 */
const JOB_PRIORITY: Record<JobKind, number> = { resume: 50, agent: 100, deliver: 150 };

export interface SubmitRootRunOptions {
  runId: string;
  kind: JobKind;
  /** Forward-flex pointer payload (target name, plan, identity). */
  payload?: Record<string, unknown>;
  /** Override the kind-derived queue priority (lower = claimed first). */
  priority?: number;
  /**
   * Drive the run to a resting state in the calling process. Invoked only in
   * `inline` mode; in `queue` mode the run is enqueued for a runner instead.
   */
  driveInline: () => Promise<void>;
}

/**
 * Submit a root run / resume for execution, honoring the runtime's execution
 * mode. This is the single fork between the two topologies:
 *
 * - `inline` → run it now (`driveInline`); no queue or runner involved.
 * - `queue`  → enqueue a durable job (a `runWorker` claims and drives it).
 *
 * Caller must record the run's opening event(s) (`run.started`, and for
 * agents `message.user`) in the log **before** calling this, so the run is
 * identical regardless of mode — the job is only ever a pointer (D10), and
 * inline drive relies on `hasStarted()` to avoid duplicating those events.
 */
export async function submitRootRun(runtime: AgentRuntime, opts: SubmitRootRunOptions): Promise<void> {
  if (runtime.executionMode === "queue") {
    await runtime.jobQueue.enqueue({
      runId: opts.runId,
      kind: opts.kind,
      payload: opts.payload,
      priority: opts.priority ?? JOB_PRIORITY[opts.kind],
    });
    return;
  }
  await opts.driveInline();
}
