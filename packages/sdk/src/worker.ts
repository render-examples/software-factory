import { randomUUID } from "node:crypto";
import type { JobQueue, JobRecord, RunStore } from "@render-agents/store";
import { TERMINAL_STATUSES } from "@render-agents/store";
import { RunPaused } from "@render-agents/engine";
import type { AgentRuntime } from "./runtime.js";
import { resumeRun, driveAgentTurn } from "./agents.js";

/**
 * The warm chat worker (Lane B). It claims interactive agent-turn / resume jobs
 * from the durable `JobQueue` and drives them **in-process** to a resting state,
 * keeping the gateway a thin enqueue-only front door and giving chat turns low
 * latency (no per-message container cold-start). Durable pipelines (Lane A) do
 * NOT come here — they run on Render Workflows via `dispatchRoot`.
 *
 * Routing by `kind`:
 * - `agent`  → `driveAgentTurn(runtime, runId)` — one chat turn, in-process,
 *   thread-scoped memory; `agent.task()` children still offload via the dispatcher.
 * - `resume` → `resumeRun(runId, runtime)` — HITL within a turn.
 *
 * Reconciliation with D3 (no blind re-runs): a claimed job is `complete()`d when
 * its run reaches any terminal state (`completed`/`failed`/`cancelled`) OR parks
 * (`paused`). It is only `fail({ requeue })`d when the run is interrupted with no
 * terminal/paused event (a genuine crash/transient), where resume-by-replay
 * makes the re-drive idempotent. `maxAttempts` is thus a delivery/crash-loop
 * budget, not a logic-retry count.
 */

/** Processes a single claimed job. Resolves on success, throws to retry. */
export type JobProcessor = (job: JobRecord) => Promise<void>;

export interface RunWorkerOptions {
  /** Stable id for this runner; defaults to a random id. */
  workerId?: string;
  /** Max concurrently-driven jobs. Default 4. */
  concurrency?: number;
  /** Fallback poll interval (ms) covering delayed/backoff jobs + missed NOTIFYs. Default 1000. */
  pollMs?: number;
  /** Visibility timeout (ms): a claimed job idle this long is reclaimable. Default 60000. */
  staleMs?: number;
  /** Reaper sweep interval (ms). Default = `staleMs`. */
  reapIntervalMs?: number;
  /** External stop signal (in addition to `handle.stop()`). */
  signal?: AbortSignal;
  /** Observe processing/loop errors (never thrown out of the loop). */
  onError?: (err: unknown, job?: JobRecord) => void;
}

export interface WorkerHandle {
  /** Stop claiming, drain in-flight jobs, release the tail client, and resolve. */
  stop(): Promise<void>;
  /** Resolves when the loop has fully stopped and drained. */
  readonly done: Promise<void>;
}

/**
 * Compute a backoff delay (ms) from the claim count: exponential with a cap and
 * light jitter so a thundering herd of requeued jobs spreads out.
 */
function backoffMs(attempts: number): number {
  const base = Math.min(30_000, 250 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

/**
 * Build the job processor: routes by kind and reconciles the job outcome with
 * the run's actual resting state in the event log (D3-correct).
 */
export function buildJobProcessor(runtime: AgentRuntime): JobProcessor {
  const queue = runtime.jobQueue;
  const store = runtime.store;

  return async (job: JobRecord): Promise<void> => {
    // A run cancelled while still queued is settled without driving it.
    if (await runtime.cancelStore.isCancelled(job.runId)) {
      await queue.complete(job.id);
      return;
    }

    // Terminal gate: if the run already reached a terminal state (e.g. a crash
    // between `run.completed` and `complete()`, then re-claimed), the job is done
    // — never re-drive a settled run.
    const pre = await store.getRun(job.runId);
    if (pre && TERMINAL_STATUSES.has(pre.status)) {
      await queue.complete(job.id);
      return;
    }

    try {
      await driveByKind(job, runtime);
    } catch (err) {
      if (err instanceof RunPaused) {
        // Parked awaiting approval/input — settled. A `resume` job re-drives it
        // when the approval resolves / input arrives.
        await queue.complete(job.id);
        return;
      }
      // The driver threw. If the run nonetheless recorded a terminal state
      // (a handler that emitted `run.failed`) or parked, honor it (D3: no
      // re-run). Otherwise it is a genuine crash/transient → requeue with
      // backoff for crash recovery (bounded by the delivery budget).
      const after = await store.getRun(job.runId);
      if (after && (TERMINAL_STATUSES.has(after.status) || after.status === "paused")) {
        await queue.complete(job.id);
        return;
      }
      await queue.fail(job.id, {
        requeue: true,
        backoffMs: backoffMs(job.attempts),
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Driver returned normally → the run reached a resting state. Done.
    await queue.complete(job.id);
  };
}

async function driveByKind(job: JobRecord, runtime: AgentRuntime): Promise<void> {
  switch (job.kind) {
    case "agent": {
      const run = await runtime.store.getRun(job.runId);
      if (!run) {
        // The gateway records `run.started` before enqueue, so a missing run row
        // is a contract violation (or the run was deleted out-of-band). Fail
        // loudly (→ retry/backoff → dead-letter) rather than silently marking the
        // job complete, which would hide the anomaly (CR-14).
        throw new Error(`agent job "${job.id}": run "${job.runId}" not found`);
      }
      // Contract: the gateway records the opening turn (`run.started` +
      // `message.user`) before enqueue — the run row satisfies the job's FK and
      // the runner's hasStarted() guard then drives without duplicating them.
      // The root turn runs warm IN-PROCESS here (low latency); only `agent.task()`
      // children offload to Render via the dispatcher.
      await driveAgentTurn(runtime, job.runId);
      return;
    }
    case "resume": {
      // resumeRun catches RunPaused internally (returns a paused result), so a
      // re-park does not throw; non-resumable states throw and are reconciled by
      // the processor's terminal gate.
      await resumeRun(job.runId, runtime);
      return;
    }
    default: {
      const exhaustive: never = job.kind;
      throw new Error(`runWorker: unknown job kind "${String(exhaustive)}"`);
    }
  }
}

/**
 * Start the runner loop. Returns a handle to stop + await it. The loop:
 * - claims up to `concurrency` jobs, driving each via the processor;
 * - wakes immediately on `tail()` NOTIFY (new enqueue) and on a freed slot;
 * - polls every `pollMs` as a fallback for delayed/backoff jobs;
 * - sweeps stale (crashed-runner) jobs every `reapIntervalMs` via `reap()`.
 */
export function runWorker(runtime: AgentRuntime, opts?: RunWorkerOptions): WorkerHandle {
  const processor = buildJobProcessor(runtime);
  return runWorkerLoop(runtime.jobQueue, processor, { ...opts, store: runtime.store });
}

interface LoopOptions extends RunWorkerOptions {
  store: RunStore;
}

/**
 * The generic claim loop, decoupled from execution wiring (testable with a mock
 * processor). `runWorker` is the wired entrypoint.
 */
export function runWorkerLoop(
  queue: JobQueue,
  process: JobProcessor,
  opts: LoopOptions,
): WorkerHandle {
  const workerId = opts.workerId ?? `worker-${randomUUID()}`;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const pollMs = opts.pollMs ?? 1000;
  const staleMs = opts.staleMs ?? 60_000;
  const reapIntervalMs = opts.reapIntervalMs ?? staleMs;
  const onError = opts.onError ?? (() => {});

  const ac = new AbortController();
  const abort = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
  }

  const inflight = new Set<Promise<void>>();

  // Single-slot wake: set just before awaiting, fired by NOTIFY / reaper / a
  // freed slot. A missed wake (fired before registration) is covered by the poll.
  let wakeResolve: (() => void) | null = null;
  const wake = (): void => {
    const r = wakeResolve;
    if (r) {
      wakeResolve = null;
      r();
    }
  };

  // Wake on enqueue NOTIFY (LISTEN client released when the signal aborts).
  const tailDone = (async () => {
    try {
      const notifications = queue.tail(ac.signal)[Symbol.asyncIterator]();
      while (!(await notifications.next()).done) {
        wake();
      }
    } catch (err) {
      if (!ac.signal.aborted) onError(err);
    }
  })();

  // Periodic reaper: requeue/dead-letter jobs from crashed runners.
  const reaper = setInterval(() => {
    queue
      .reap(staleMs)
      .then((n) => { if (n > 0) wake(); })
      .catch((err) => onError(err));
  }, reapIntervalMs);
  if (typeof reaper.unref === "function") reaper.unref();

  const runOne = (job: JobRecord): void => {
    const p = (async () => {
      try {
        await process(job);
      } catch (err) {
        onError(err, job);
      }
    })().finally(() => {
      inflight.delete(p);
      wake(); // a slot freed → re-fill capacity
    });
    inflight.add(p);
  };

  const loop = (async () => {
    try {
      while (!ac.signal.aborted) {
        let claimedAny = false;
        while (inflight.size < concurrency && !ac.signal.aborted) {
          let job: JobRecord | undefined;
          try {
            job = await queue.claim(workerId);
          } catch (err) {
            onError(err);
            break;
          }
          if (!job) break;
          claimedAny = true;
          runOne(job);
        }
        if (ac.signal.aborted) break;
        // Nothing more to claim right now (queue drained or at capacity): sleep
        // until a wake or the poll timeout.
        if (!claimedAny || inflight.size >= concurrency) {
          await waitForWake(pollMs, ac.signal, (resolve) => { wakeResolve = resolve; });
        }
      }
    } finally {
      clearInterval(reaper);
      await Promise.allSettled([...inflight]);
      await tailDone.catch(() => {});
    }
  })();

  return {
    stop: async () => {
      abort();
      await loop;
    },
    get done() {
      return loop;
    },
  };
}

/**
 * Resolve when any of: the `register`ed wake fires, the signal aborts, or the
 * timeout elapses. Self-cleaning so timers/listeners never leak.
 */
function waitForWake(
  timeoutMs: number,
  signal: AbortSignal,
  register: (resolve: () => void) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    signal.addEventListener("abort", finish, { once: true });
    register(finish);
  });
}
