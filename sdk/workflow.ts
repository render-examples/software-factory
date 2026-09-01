/**
 * workflow() — Durability 2.0-compatible API backed by the existing store.
 *
 * Provides `ctx.step()` and `ctx.sleep()` with the same signatures the
 * real Render Workflows Durability 2.0 SDK will ship. When that lands,
 * swap the import:
 *
 *   Before: import { workflow } from "#factory/sdk";
 *   After:  import { workflow } from "@renderinc/sdk/workflows";
 *
 * Internally, each `ctx.step()` uses store.runs.beginStep/completeStep
 * for memoization, and the workflow() wrapper manages execution locks,
 * heartbeats, and terminal state — invisible to the workflow author.
 */
import { randomUUID } from "node:crypto";
import { task } from "@renderinc/sdk/workflows";
import {
  factoryStore,
  type ExecutionHandle,
  type FactoryStore,
} from "#factory/store";

// ---------------------------------------------------------------------------
// Public types — matches the Durability 2.0 SDK contract
// ---------------------------------------------------------------------------

export interface WorkflowRunContext {
  rootRunId: string;
  runId: string;
  stepKey: string;
  generation: number;
}

export interface WorkflowContext {
  /** The durable run ID for this workflow execution. */
  readonly runId: string;

  /**
   * Run a named step. The result is memoized; on replay the stored value
   * is returned without re-executing `fn`.
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Durable sleep. In the real SDK this kills the process and resumes
   * later. The shim keeps the process alive with setTimeout.
   * Pass a duration string like "5s", "2m", "1h", "7 days".
   */
  sleep(duration: string): Promise<void>;

  /**
   * Build a run context for a child agent task, linking it to a named
   * workflow step for traceability. This is a factory-specific extension
   * that can be dropped when Durability 2.0 ships its own tracing.
   */
  runContext(stepName: string): WorkflowRunContext;
}

export interface WorkflowConfig {
  name: string;
  timeoutSeconds?: number;
  retry?: {
    maxRetries: number;
    waitDurationMs: number;
    backoffScaling: number;
  };
  plan?: string;
}

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

function parseDuration(duration: string): number {
  const match = duration.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?|h|hours?|d|days?)$/i);
  if (!match) throw new Error(`Invalid duration: "${duration}"`);
  const value = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "ms") return value;
  if (unit.startsWith("s")) return value * 1_000;
  if (unit.startsWith("m") && !unit.startsWith("ms")) return value * 60_000;
  if (unit.startsWith("h")) return value * 3_600_000;
  if (unit.startsWith("d")) return value * 86_400_000;
  throw new Error(`Unknown duration unit: "${unit}"`);
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const EXECUTION_TTL_SECONDS = 30;
const HEARTBEAT_INTERVAL_MS = 10_000;
// ---------------------------------------------------------------------------
// Error classification for failed steps
// ---------------------------------------------------------------------------

function classifyError(error: unknown): string {
  if (error instanceof Error) {
    if (/lease/i.test(error.message)) return "lease_lost";
    if (/sandbox/i.test(error.message)) return "sandbox_error";
    if (/github/i.test(error.message)) return "github_error";
    if (/invalid structured output/i.test(error.message)) return "invalid_model_output";
  }
  return "step_error";
}

// ---------------------------------------------------------------------------
// workflow() — the shim
// ---------------------------------------------------------------------------

export function workflow<TInput, TResult>(
  config: WorkflowConfig,
  handler: (ctx: WorkflowContext, input: TInput) => Promise<TResult>,
) {
  return task(
    {
      name: config.name,
      plan: config.plan,
      ...(config.retry && { retry: config.retry }),
      ...(config.timeoutSeconds && { timeoutSeconds: config.timeoutSeconds }),
    },
    async function durableWorkflow(rawInput: TInput): Promise<TResult> {
      const store = factoryStore();
      const runId = (rawInput as Record<string, unknown>)?.runId as string | undefined
        ?? randomUUID();

      await store.runs.ensureRun({
        id: runId,
        rootRunId: runId,
        kind: "workflow",
        name: config.name,
        triggerType: "workflow",
        input: rawInput as Record<string, unknown>,
      });

      const priorResult = await store.runs.getTerminal<TResult>(runId);
      if (priorResult.found) {
        if (priorResult.value === undefined) {
          throw new Error("Terminal workflow run is missing its result");
        }
        return priorResult.value;
      }

      const executionId = randomUUID();
      const claim = await store.runs.beginExecution(runId, executionId, EXECUTION_TTL_SECONDS);
      if (claim.kind === "busy") {
        throw new Error(`Workflow "${config.name}" run "${runId}" is already executing`);
      }
      let execution: ExecutionHandle = claim.execution;

      let heartbeatError: Error | undefined;
      const heartbeat = setInterval(() => {
        void store.runs
          .refreshExecution(execution, EXECUTION_TTL_SECONDS)
          .then((refreshed) => { execution = refreshed; })
          .catch((error) => {
            heartbeatError = error instanceof Error ? error : new Error(String(error));
          });
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();

      const ctx = createWorkflowContext(runId, store, execution, () => {
        if (heartbeatError) throw heartbeatError;
        return execution;
      });

      try {
        const result = await handler(ctx, rawInput);
        if (heartbeatError) throw heartbeatError;
        await store.completeRun({
          runId,
          execution,
          status: "completed",
          result,
        });
        return result;
      } catch (error) {
        await store.runs.incrementFailureCount(runId, execution).catch(() => {});
        throw error;
      } finally {
        clearInterval(heartbeat);
        await store.runs.releaseExecution(execution).catch(() => {});
      }
    },
  );
}

// ---------------------------------------------------------------------------
// WorkflowContext implementation
// ---------------------------------------------------------------------------

function createWorkflowContext(
  runId: string,
  store: FactoryStore,
  _initialExecution: ExecutionHandle,
  getExecution: () => ExecutionHandle,
): WorkflowContext {
  const stepCounts = new Map<string, number>();

  function uniqueStepKey(name: string): string {
    const count = stepCounts.get(name) ?? 0;
    stepCounts.set(name, count + 1);
    return count === 0 ? name : `${name}#${count}`;
  }

  return {
    runId,

    runContext(stepName: string): WorkflowRunContext {
      return { rootRunId: runId, runId, stepKey: stepName, generation: 0 };
    },

    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const key = uniqueStepKey(name);
      const execution = getExecution();

      const state = await store.runs.beginStep<T>(
        runId,
        key,
        "guarded",
        execution,
      );

      if (state.kind === "reuse") return state.value;
      if (state.kind === "blocked") {
        throw new Error(
          `Step "${key}" was interrupted mid-execution; refusing non-deterministic replay`,
        );
      }
      if (state.kind === "busy") {
        throw new Error(`Step "${key}" is already executing`);
      }

      try {
        const value = await fn();
        const storable = value === undefined ? (null as T) : value;
        return await store.runs.completeStep(runId, key, storable, getExecution());
      } catch (error) {
        await store.runs
          .failStep(runId, key, classifyError(error), getExecution())
          .catch(() => {});
        throw error;
      }
    },

    async sleep(duration: string): Promise<void> {
      const ms = parseDuration(duration);
      const key = uniqueStepKey(`__sleep:${duration}`);
      const execution = getExecution();

      const state = await store.runs.beginStep<true>(
        runId,
        key,
        "safe",
        execution,
      );

      if (state.kind === "reuse") return;

      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      await store.runs.completeStep(runId, key, true, getExecution());
    },
  };
}
