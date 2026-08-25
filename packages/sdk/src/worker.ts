import { randomUUID } from "node:crypto";
import type { JobQueue, JobRecord, RunStore } from "@render-factory/store";
import { TERMINAL_STATUSES } from "@render-factory/store";
import { RunPaused } from "@render-factory/engine";
import type { AgentRuntime } from "./runtime.js";
import { resumeRun, driveAgentTurn } from "./agents.js";
import { deliverForRun } from "./channel-delivery.js";

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
    // Outbound delivery: runs BEFORE the cancel/terminal gate below (the run is
    // intentionally terminal), else the gate would complete the job without
    // delivering. `deliverForRun` is idempotent (skips redelivery).
    if (job.kind === "deliver") {
      try {
        await deliverForRun(runtime, job.runId);
        await queue.complete(job.id);
      } catch (err) {
        await queue.fail(job.id, {
          requeue: true,
          backoffMs: backoffMs(job.attempts),
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // A run cancelled while still queued is settled without driving it.
    if (await runtime.cancelStore.isCancelled(job.runId)) {
      await queue.complete(job.id);
      return;
    }

    // Terminal gate: if the run already reached a terminal state (e.g. crash
    // between `run.completed` and `complete()`, then re-claimed), never re-drive.
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
      // Driver threw. If the run nonetheless recorded terminal/paused state,
      // honor it (D3: no re-run). Otherwise it's a genuine crash/transient →
      // requeue with backoff, bounded by the delivery budget.
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
        // Gateway records `run.started` before enqueue, so a missing run row is
        // a contract violation. Fail loudly (retry/backoff/dead-letter) rather
        // than silently completing, which would hide the anomaly (CR-14).
        throw new Error(`agent job "${job.id}": run "${job.runId}" not found`);
      }
      // Root turn runs warm in-process here (low latency); only `agent.task()`
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
    case "deliver":
      // Delivery is handled ahead of driveByKind (must bypass the terminal
      // gate); reaching here would be a routing bug.
      throw new Error(`runWorker: "deliver" job reached driveByKind`);
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
  const claim = runWorkerLoop(runtime.jobQueue, processor, { ...opts, store: runtime.store });

  // No channels configured → no outbound delivery producer (zero cost).
  if (runtime.channels.size === 0) return claim;

  // Outbound delivery producer (lane-agnostic): tail the shared event log and,
  // on a terminal channel-bound run, enqueue a `deliver` job the claim loop
  // drains via `deliverForRun`. Both lanes complete to the same log.
  const ac = new AbortController();
  if (opts?.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  const produce = runDeliveryProducer(runtime, ac.signal, opts?.onError);
  return {
    stop: async () => { ac.abort(); await Promise.all([claim.stop(), produce]); },
    get done() { return Promise.all([claim.done, produce]).then(() => undefined); },
  };
}

/**
 * Watch the event log for terminal channel-bound runs and enqueue a `deliver`
 * job for each (idempotent by explicit job id). Post-commit by construction — a
 * `tail` only sees committed events — so it never races a run's own commit.
 */
async function runDeliveryProducer(
  runtime: AgentRuntime,
  signal: AbortSignal,
  onError?: (err: unknown, job?: JobRecord) => void,
): Promise<void> {
  const store = runtime.store;
  try {
    for await (const event of store.events.tail({}, signal)) {
      // Deliver on completion (reply) and pause (HITL input prompt).
      if (event.payload.type !== "run.completed" && event.payload.type !== "run.paused") continue;
      try {
        const run = await store.getRun(event.runId);
        if (!run?.channel || !run.externalConversationId) continue;
        if (!runtime.channels.get(run.channel)?.deliver) continue; // inbound-only channel
        // Per-event job id (`seq` gap-free per run) keeps tail replay idempotent;
        // deliver jobs are exempt from the per-run active index so they coexist
        // with the run's still-active turn job.
        await runtime.jobQueue.enqueue({
          id: `deliver:${event.runId}:${event.seq}`,
          runId: event.runId,
          kind: "deliver",
          priority: 150,
        });
      } catch (err) {
        onError?.(err);
      }
    }
  } catch (err) {
    if (!signal.aborted) onError?.(err);
  }
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

  // Single-slot wake: set just before awaiting, fired by NOTIFY/reaper/freed
  // slot. A missed wake (fired before registration) is covered by the poll.
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
