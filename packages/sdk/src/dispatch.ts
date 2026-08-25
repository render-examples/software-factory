import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RunStore, CancelStore, Tracer } from "@render-factory/store";
import { buildEventRecord } from "@render-factory/store";
import type {
  AgentDefinition,
  AgentInput,
  AgentOutput,
  RenderPlan,
  ModelClient,
  ContextManager,
  DelegationLimits,
  ToolSource,
  Suspender,
} from "@render-factory/engine";
import { noopTracer, RunPaused, RunCancelled } from "@render-factory/engine";
import type { AgentRuntime, TaskDispatcher, DispatchOptions, RunnerRegistry, RootDispatchJob } from "./runtime.js";
import type { WorkflowDefinition } from "./workflow.js";
import { runAgentInProcess } from "./run-in-process.js";

/** Reserved step name used to memoize a task's output for idempotent re-dispatch. */
const TASK_OUTPUT_STEP = "__task_output__";

/**
 * Deterministic dispatch key from runId + agent name + call ordinal, so
 * handler replay (after crash/restart) re-dispatches to the same child run.
 */
export function computeDispatchKey(runId: string, agentName: string, callSeq: number): string {
  return createHash("sha256")
    .update(`${runId}\0${agentName}\0${callSeq}`)
    .digest("hex");
}

/** Throws at dispatch time rather than letting non-serializable data cross a
 *  process boundary and fail inscrutably on the receiving end. */
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
  oauthStore?: import("@render-factory/store").OAuthStore;
  oauthRefreshers?: Map<string, import("@render-factory/engine").OAuthRefresher>;
  /** Transient token-delta bus (D13) for live streaming; never persisted. */
  deltaBus?: import("@render-factory/store").DeltaBus;
  /** HITL suspension strategy (default: resume-by-replay). */
  suspender?: Suspender;
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

  /** Single-flight by runId: concurrent dispatches of the same deterministic
   *  runId share one execution instead of both racing the memo lookup (CR-15). */
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

    // Idempotent re-dispatch: replay returns the memoized output instead of
    // re-executing the child.
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
      suspender: this.opts.suspender,
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
   * Trigger a workflow root in-process (Lane A, dev/test). Errors (RunPaused or
   * handler failure) are swallowed — `executeHandler` already recorded the
   * terminal/paused state, and `dispatchRoot` is fire-and-forget, so the caller
   * reads the outcome from the run record.
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

  /** Memoized output of a prior completed dispatch for this runId, if any. */
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

    const { Render } = await importRenderSdk();
    const client = new Render(renderClientOptions());
    // runTask result is `{ status, results }`; our handler takes one arg and
    // returns one value, so unwrap index 0.
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
   * Trigger a workflow root on Render (Lane A, production) via non-blocking
   * `startTask` against the plan-tiered `workflow@<plan>` task. Fire-and-forget:
   * gateway records `run.started`, triggers, then returns `202`. JSON only —
   * the container resolves the workflow by name.
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
    // Constructor requires *a* token even in local-dev (ignored by the local
    // task server), so pass a placeholder when none is set.
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
  // `@renderinc/sdk` is an optional peer living in the app's deps (not this
  // package), so resolve from the app's cwd rather than packages/sdk. A bare
  // dynamic import would resolve relative to this module and fail under pnpm's
  // isolated layout. Variable specifier also keeps tsc from resolving at build.
  const moduleName = "@renderinc/sdk";
  try {
    const require = createRequire(pathToFileURL(join(process.cwd(), "noop.js")).href);
    const resolved = require.resolve(moduleName);
    return (await import(pathToFileURL(resolved).href)) as never;
  } catch (cwdErr) {
    // Fallback: resolve relative to this module (SDK hoisted next to us).
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
    suspender: runtime.suspender,
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
 * Generic workflow-root handler running INSIDE a Render Workflows container
 * (bound to `workflow@<plan>`). Resolves the workflow by name from the
 * deployed image (JSON only across `runTask`/`startTask`) and drives it.
 *
 * `agent.run()` is in-process here; `agent.task()` spawns an isolated child
 * task. A child parking the handler throws `RunPaused`, recorded as
 * `run.paused` before rethrowing — Render marks the task done (resume =
 * re-trigger + replay).
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
    // Render requires a result or throw; returning void would mark an
    // otherwise-successful run as a FAILED task. Event log is authoritative.
    return { runId: args.runId, status: "completed" };
  } catch (err) {
    // HITL pause is settled, not a failure — return a result so Render marks
    // the task done (no spurious retry/failure count).
    if (err instanceof RunPaused) {
      return { runId: args.runId, status: "paused" };
    }
    // Cancellation (E3) is also a settled terminal state, not a failure.
    if (err instanceof RunCancelled) {
      return { runId: args.runId, status: "cancelled" };
    }
    // Genuine failure: run.failed already recorded; rethrow to fail the task.
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
 * Detect whether the Render Workflows runtime is available: selected when
 * `RENDER_SDK_SOCKET_PATH` (set in a deployed container) or
 * `RENDER_USE_LOCAL_DEV` (CLI local-dev workflows mode) is present. Both mean
 * "a workflow server is reachable"; otherwise fall back to in-process.
 */
export function isWorkflowsEnvironment(): boolean {
  return !!(process.env.RENDER_SDK_SOCKET_PATH || process.env.RENDER_USE_LOCAL_DEV);
}

/**
 * Detect whether the gateway can *trigger* workflow roots via the REST client
 * (`startTask`) from a process that isn't itself a Workflows container — the
 * gateway holds only `RENDER_API_KEY` + `RENDER_WORKFLOW_SLUG`, no socket.
 */
export function isRootTriggerEnvironment(): boolean {
  return !!(process.env.RENDER_API_KEY && process.env.RENDER_WORKFLOW_SLUG);
}
