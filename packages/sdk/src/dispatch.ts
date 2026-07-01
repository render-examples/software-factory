import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunStore, CancelStore, Tracer } from "@render-agents/store";
import { buildEventRecord } from "@render-agents/store";
import type {
  AgentDefinition,
  AgentInput,
  AgentOutput,
  RenderPlan,
  ModelClient,
  ContextManager,
  DelegationLimits,
  ToolSource,
} from "@render-agents/engine";
import { noopTracer, RunPaused, RunCancelled } from "@render-agents/engine";
import type { AgentRuntime, TaskDispatcher, DispatchOptions, RunnerRegistry, RootDispatchJob } from "./runtime.js";
import type { WorkflowDefinition } from "./workflow.js";
import { runAgentInProcess } from "./run-in-process.js";

/** Reserved step name used to memoize a task's output for idempotent re-dispatch. */
const TASK_OUTPUT_STEP = "__task_output__";

/**
 * Compute a deterministic dispatch key from the caller's runId, the
 * target agent name, and the call ordinal. This ensures re-execution
 * of a handler (after crash/restart) re-dispatches to the same child
 * run rather than creating a duplicate.
 */
export function computeDispatchKey(runId: string, agentName: string, callSeq: number): string {
  return createHash("sha256")
    .update(`${runId}\0${agentName}\0${callSeq}`)
    .digest("hex");
}

/**
 * Validate that input is JSON-serializable. Throws at dispatch time
 * rather than letting non-serializable data cross a process boundary
 * and fail inscrutably on the receiving end.
 */
function assertSerializable(input: unknown, label: string): void {
  try {
    JSON.stringify(input);
  } catch (err) {
    throw new Error(
      `${label} is not JSON-serializable. Task dispatch requires all data to ` +
      `cross process boundaries cleanly. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- In-Process Dispatcher (local dev / testing) ---

export interface InProcessDispatcherOptions {
  store: RunStore;
  runners: RunnerRegistry;
  model: ModelClient;
  contextManager: ContextManager;
  cancelStore: CancelStore;
  toolSources: Map<string, ToolSource>;
  getDefinition: (name: string) => AgentDefinition | undefined;
  /** Resolve a workflow definition by name for the in-process root drive (`dispatchRoot`). */
  getWorkflow?: (name: string) => WorkflowDefinition | undefined;
  tracer?: Tracer;
  delegation?: Partial<DelegationLimits>;
  oauthStore?: import("@render-agents/store").OAuthStore;
  oauthRefreshers?: Map<string, import("@render-agents/engine").OAuthRefresher>;
  /** Transient token-delta bus (D13) for live streaming; never persisted. */
  deltaBus?: import("@render-agents/store").DeltaBus;
}

/**
 * In-process dispatcher: runs the agent in the same process as the caller.
 * Provides identical observable behavior (events, spans, output shape) to
 * production dispatch, minus container isolation and retries.
 *
 * This is the "no workflow server" fallback — used in local dev, tests, and
 * any environment where `@renderinc/sdk` is not available.
 */
export class InProcessDispatcher implements TaskDispatcher {
  constructor(private readonly opts: InProcessDispatcherOptions) {}

  /** In-process single-flight by runId: two concurrent dispatches of the same
   *  (deterministic) runId share one execution instead of both slipping past the
   *  memo lookup and running the child twice (CR-15). */
  private readonly inflight = new Map<string, Promise<AgentOutput>>();

  async dispatch(agentName: string, input: AgentInput, dispatchOpts: DispatchOptions): Promise<AgentOutput> {
    const runId = dispatchOpts.runId;
    const inflight = this.inflight.get(runId);
    if (inflight) return inflight;
    const run = this.doDispatch(agentName, input, dispatchOpts);
    this.inflight.set(runId, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(runId);
    }
  }

  private async doDispatch(agentName: string, input: AgentInput, dispatchOpts: DispatchOptions): Promise<AgentOutput> {
    assertSerializable(input, `Task input for agent "${agentName}"`);

    const runId = dispatchOpts.runId;

    // Idempotent re-dispatch: a previously completed run for this (deterministic)
    // runId memoized its output as a reserved step — replay returns it instead
    // of re-executing the child.
    const existing = await this.lookupExistingResult(runId);
    if (existing) return existing;

    const definition = this.opts.getDefinition(agentName);
    if (!definition) {
      throw new Error(
        `InProcessDispatcher: agent "${agentName}" not found. ` +
        `Ensure the agent is loaded before dispatching.`,
      );
    }

    const result = await runAgentInProcess(definition, input, {
      store: this.opts.store,
      tracer: this.opts.tracer ?? noopTracer,
      runners: this.opts.runners,
      contextManager: this.opts.contextManager,
      cancelStore: this.opts.cancelStore,
      toolSources: this.opts.toolSources,
      getDefinition: this.opts.getDefinition,
      childDispatcher: this,
      delegation: this.opts.delegation,
      oauthStore: this.opts.oauthStore,
      oauthRefreshers: this.opts.oauthRefreshers,
      deltaBus: this.opts.deltaBus,
    }, {
      runId,
      parentSpanId: dispatchOpts.parentSpanId,
      userId: dispatchOpts.userId,
      threadId: dispatchOpts.threadId,
      depth: (dispatchOpts.depth ?? 0) + 1,
      signal: dispatchOpts.signal,
      cancelScopeId: dispatchOpts.cancelScopeId,
    });

    assertSerializable(result, `Task output from agent "${agentName}"`);

    // Memoize for idempotent re-dispatch (durable, event-sourced).
    await this.opts.store.events.append(
      buildEventRecord(
        runId,
        { type: "step.completed", name: TASK_OUTPUT_STEP, result },
        { agentName: definition.name },
      ),
    );
    return result;
  }

  /**
   * Trigger a workflow root in-process (Lane A, dev/test). Drives the handler to
   * a resting state via `wf.drive(runId)`. A `RunPaused` (HITL) or a handler
   * failure is swallowed here — the terminal/paused state is already recorded on
   * the run by `executeHandler`, and `dispatchRoot` is fire-and-forget, so the
   * caller reads the outcome from the run record, not a thrown error.
   */
  async dispatchRoot(job: RootDispatchJob): Promise<void> {
    const wf = this.opts.getWorkflow?.(job.workflow);
    if (!wf) {
      throw new Error(
        `InProcessDispatcher.dispatchRoot: no workflow "${job.workflow}" registered. ` +
        `Ensure it was loaded via loadWorkflows() / bindWorkflow() before dispatch.`,
      );
    }
    try {
      await wf.drive(job.runId);
    } catch {
      // Terminal (run.failed) / paused (run.paused) is recorded by executeHandler.
    }
  }

  /**
   * Return the memoized output of a prior completed dispatch for this runId, if
   * any. The output is persisted as a reserved `step.completed` event, so a
   * re-dispatch (handler replay after crash/pause) short-circuits to the same
   * result rather than re-running the child.
   */
  private async lookupExistingResult(runId: string): Promise<AgentOutput | undefined> {
    const memo = await this.opts.store.getStepResult(runId, TASK_OUTPUT_STEP);
    return memo ? (memo.value as AgentOutput) : undefined;
  }
}

// --- Render Workflows Dispatcher (production) ---

/**
 * Render Workflows dispatcher. In production, dispatches agent runs as
 * isolated chained tasks via `@renderinc/sdk/workflows`.
 *
 * Each agent plan maps to a registered `agent@<plan>` task, which binds
 * the compute tier. The handler in the workflow service container reloads
 * the agent definition by name and runs it.
 *
 * When `@renderinc/sdk` is not available (local dev), this class is never
 * instantiated — `createRuntime` picks `InProcessDispatcher` instead.
 */
export class RenderWorkflowsDispatcher implements TaskDispatcher {
  private readonly workflowSlug: string;

  constructor(opts: { workflowSlug: string }) {
    this.workflowSlug = opts.workflowSlug;
  }

  async dispatch(agentName: string, input: AgentInput, opts: DispatchOptions): Promise<AgentOutput> {
    assertSerializable(input, `Task input for agent "${agentName}"`);

    const plan = opts.plan ?? "standard";
    const taskSlug = `${this.workflowSlug}/agent@${plan}`;

    const taskInput = {
      agentName,
      input,
      runId: opts.runId,
      parentSpanId: opts.parentSpanId,
      userId: opts.userId,
      threadId: opts.threadId,
      depth: opts.depth ?? 0,
      idempotencyKey: opts.idempotencyKey,
      cancelScopeId: opts.cancelScopeId,
    };

    assertSerializable(taskInput, `Serialized task payload for "${agentName}"`);

    // Dynamic import to avoid hard dependency on @renderinc/sdk in dev
    const { Render } = await importRenderSdk();
    const client = new Render(renderClientOptions());
    // runTask resolves once the task completes; the result is `{ status, results }`
    // where `results` is the positional return array. Our handler takes one arg
    // (`[taskInput]`) and returns one value (the AgentOutput), so unwrap index 0.
    const taskRun = await client.workflows.runTask(taskSlug, [taskInput]);
    const output = taskRun?.results?.[0];

    if (!output || typeof output !== "object") {
      throw new Error(
        `RenderWorkflowsDispatcher: task "${taskSlug}" returned invalid result ` +
        `(status=${taskRun?.status ?? "unknown"})`,
      );
    }

    return output as AgentOutput;
  }

  /**
   * Trigger a workflow root on Render (Lane A, production). Uses the *non-blocking*
   * `startTask` (returns a `taskRunId` immediately) against the plan-tiered
   * `workflow@<plan>` task — Render durably queues it, provisions an isolated
   * container, and scales to zero. Fire-and-forget: the gateway records
   * `run.started` first, then triggers, then returns `202`. JSON only — the
   * container resolves the workflow by name (no closures cross the wire).
   */
  async dispatchRoot(job: RootDispatchJob): Promise<void> {
    const plan = job.plan ?? "standard";
    const taskSlug = `${this.workflowSlug}/workflow@${plan}`;
    const taskInput = { workflow: job.workflow, runId: job.runId };
    assertSerializable(taskInput, `Serialized root payload for workflow "${job.workflow}"`);

    const { Render } = await importRenderSdk();
    const client = new Render(renderClientOptions());
    await client.workflows.startTask(taskSlug, [taskInput]);
  }
}

/**
 * Build `Render` client options. In local-dev mode (`RENDER_USE_LOCAL_DEV`) the
 * client targets the Render CLI local task server and needs no API token; the
 * constructor otherwise *requires* `RENDER_API_KEY`, so we must pass
 * `useLocalDev` explicitly (the constructor does not infer it from the env).
 * In production we pass nothing and let it read `RENDER_API_KEY`.
 */
function renderClientOptions(): { useLocalDev: true; localDevUrl?: string; token: string } | undefined {
  if (process.env.RENDER_USE_LOCAL_DEV === "true") {
    // The constructor requires *a* token even in local-dev (the local task
    // server ignores its value), so pass a placeholder when none is set.
    return {
      useLocalDev: true,
      localDevUrl: process.env.RENDER_LOCAL_DEV_URL,
      token: process.env.RENDER_API_KEY ?? "local-dev",
    };
  }
  return undefined;
}

async function importRenderSdk(): Promise<{
  Render: new (opts?: { useLocalDev?: boolean; localDevUrl?: string; token?: string }) => {
    workflows: {
      runTask: (slug: string, args: unknown[]) => Promise<{ status?: string; results?: unknown[] }>;
      startTask: (slug: string, args: unknown[]) => Promise<{ taskRunId: string }>;
    };
  };
}> {
  // `@renderinc/sdk` is an optional peer — it lives in the *application's*
  // dependencies (the gateway / workflows-host service), not in this package, so
  // it must be resolved from the app's working directory rather than from
  // packages/sdk (where it is intentionally absent). A bare dynamic `import()`
  // would resolve relative to this module and fail under pnpm's isolated layout.
  // Using a variable specifier also keeps tsc from resolving it at build time.
  const moduleName = "@renderinc/sdk";
  try {
    const require = createRequire(pathToFileURL(join(process.cwd(), "noop.js")).href);
    const resolved = require.resolve(moduleName);
    return (await import(pathToFileURL(resolved).href)) as never;
  } catch (cwdErr) {
    // Fallback: resolve relative to this module (covers layouts where the SDK is
    // hoisted next to @render-agents/sdk).
    try {
      return (await import(moduleName)) as never;
    } catch (relErr) {
      const detail = cwdErr instanceof Error ? cwdErr.message : String(cwdErr);
      throw new Error(
        `RenderWorkflowsDispatcher requires @renderinc/sdk (resolved from ${process.cwd()}). ` +
        `Install it in your app, or use InProcessDispatcher for local development. Cause: ${detail}`,
        { cause: relErr },
      );
    }
  }
}

// --- Task handler (runs in workflow service container) ---

export interface AgentTaskInput {
  agentName: string;
  input: AgentInput;
  runId: string;
  parentSpanId?: string;
  userId?: string;
  threadId?: string;
  depth: number;
  idempotencyKey: string;
  /** Cancel scope (root run id) so cancellation cascades into this task container (E3). */
  cancelScopeId?: string;
}

/**
 * The handler that runs inside a Render Workflows task container.
 * Reloads the agent definition by name from the deployed image
 * (definitions are never serialized across the wire) and runs it.
 */
export async function agentTaskHandler(
  taskInput: AgentTaskInput,
  runtime: AgentRuntime,
  getDefinition: (name: string) => AgentDefinition | undefined,
): Promise<AgentOutput> {
  const { agentName, input, runId, parentSpanId, userId, threadId, depth, cancelScopeId } = taskInput;

  const definition = getDefinition(agentName);
  if (!definition) {
    throw new Error(
      `agentTaskHandler: agent "${agentName}" not found in deployed image. ` +
      `Ensure the agent markdown file exists and is loadable.`,
    );
  }

  return runAgentInProcess(definition, input, {
    store: runtime.store,
    tracer: runtime.tracer,
    runners: runtime.runners,
    contextManager: runtime.contextManager,
    cancelStore: runtime.cancelStore,
    toolSources: runtime.toolSources,
    getDefinition,
    childDispatcher: runtime.dispatcher ?? throwNoDispatcher(),
    delegation: runtime.delegation,
    oauthStore: runtime.oauthStore,
    oauthRefreshers: runtime.oauthRefreshers,
    deltaBus: runtime.deltaBus,
  }, {
    runId,
    parentSpanId,
    userId,
    threadId,
    depth: depth + 1,
    cancelScopeId,
  });
}

function throwNoDispatcher(): never {
  throw new Error("agentTaskHandler: runtime has no dispatcher configured for subagent delegation");
}

/**
 * The generic workflow-root handler that runs INSIDE a Render Workflows
 * container (bound to the `workflow@<plan>` task). It resolves the user's
 * workflow by name from the deployed image (definitions are never serialized
 * across `runTask`/`startTask` — JSON only) and drives it.
 *
 * `wf.drive(runId)` runs `executeHandler` here: `agent.run()` is in-process in
 * this container; `agent.task()` spawns an isolated child task. A child parking
 * the handler throws `RunPaused`, which `executeHandler` records as `run.paused`
 * on the root before rethrowing — Render marks the task done (resume = re-trigger
 * + replay). This mirrors `agentTaskHandler`'s resolve-by-name pattern.
 */
export async function workflowTaskHandler(
  args: { workflow: string; runId: string },
  workflows: Map<string, WorkflowDefinition>,
): Promise<{ runId: string; status: "completed" | "paused" | "cancelled" }> {
  const wf = workflows.get(args.workflow);
  if (!wf) {
    throw new Error(
      `workflowTaskHandler: no workflow "${args.workflow}" in the deployed image. ` +
      `Ensure workflows/${args.workflow}/index.ts exists and is loaded via loadWorkflows().`,
    );
  }
  try {
    await wf.drive(args.runId);
    // Return a JSON-serializable summary: the Render task runner requires a
    // result (or a throw) — returning `void` makes it mark an otherwise-
    // successful run as a FAILED task. The authoritative outcome lives in the
    // event log; this is just the task-level ack.
    return { runId: args.runId, status: "completed" };
  } catch (err) {
    // HITL pause is a *settled* state, not a failure: `executeHandler` already
    // recorded `run.paused`, and resume = re-trigger + replay. Return a result so
    // Render marks the task done (not failed → no spurious retry/failure count).
    if (err instanceof RunPaused) {
      return { runId: args.runId, status: "paused" };
    }
    // Cancellation (E3) is a settled terminal state, not a failure:
    // `executeHandler` already recorded `run.cancelled`. Return a result so
    // Render marks the task done rather than failed.
    if (err instanceof RunCancelled) {
      return { runId: args.runId, status: "cancelled" };
    }
    // Genuine failure: `run.failed` is already recorded; rethrow so Render marks
    // the task failed too.
    throw err;
  }
}

// --- Plan registration helpers ---

const VALID_PLANS: RenderPlan[] = ["starter", "standard", "pro", "pro_plus", "pro_max", "pro_ultra"];

/**
 * Compute the set of plan-tier tasks that need registration from the
 * loaded agent definitions. Always includes "standard" as the fallback.
 */
export function computeRequiredPlans(definitions: AgentDefinition[]): RenderPlan[] {
  const plans = new Set<RenderPlan>(["standard"]);
  for (const def of definitions) {
    if (def.plan && VALID_PLANS.includes(def.plan)) {
      plans.add(def.plan);
    }
  }
  return [...plans].sort();
}

// --- Dispatcher auto-detection ---

/**
 * Detect whether the Render Workflows runtime is available.
 *
 * Per the execution spec ([Execution → Runtime & composition] and
 * [Execution → Task dispatch]): the Render Workflows dispatcher is selected when
 * `RENDER_SDK_SOCKET_PATH` **or** `RENDER_USE_LOCAL_DEV` is present, and the
 * in-process fallback (`.task()` runs as `.run()`) is used when **both** are
 * unset. `RENDER_SDK_SOCKET_PATH` is set inside a deployed Render Workflow
 * service container; `RENDER_USE_LOCAL_DEV` signals the Render CLI's local-dev
 * workflows mode (where `@renderinc/sdk` provides a local workflows socket).
 * Both therefore mean "a workflow server is reachable", not "force local".
 */
export function isWorkflowsEnvironment(): boolean {
  return !!(process.env.RENDER_SDK_SOCKET_PATH || process.env.RENDER_USE_LOCAL_DEV);
}

/**
 * Detect whether the gateway can *trigger* workflow roots on Render via the REST
 * client — i.e. `startTask` from a process that is NOT itself a Workflows
 * container. This is the root-trigger counterpart to `isWorkflowsEnvironment()`
 * (in-container child chaining): the gateway holds only `RENDER_API_KEY` +
 * `RENDER_WORKFLOW_SLUG`, no socket. Sprint 01-Q open question #2.
 */
export function isRootTriggerEnvironment(): boolean {
  return !!(process.env.RENDER_API_KEY && process.env.RENDER_WORKFLOW_SLUG);
}
