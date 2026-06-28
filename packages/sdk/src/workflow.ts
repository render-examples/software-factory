import { randomUUID } from "node:crypto";
import type {
  Logger,
  Tracer,
  RunRecord,
  RunEvent,
} from "@render-agents/store";
import { buildEventRecord, idempotencyKey } from "@render-agents/store";
import type {
  RenderPlan,
  AgentDefinition,
  AgentInput,
  AgentOutput,
  RunOptions,
} from "@render-agents/engine";
import type { AgentSet, Agent } from "./agents.js";
import type { AgentRuntime } from "./runtime.js";
import { runAgentInProcess } from "./run-in-process.js";

export interface WorkflowOptions {
  name?: string;
  timeout?: number;
  retries?: number;
  plan?: RenderPlan;
}

export interface WorkflowContext {
  readonly runId: string;
  readonly trigger: string;
  readonly input: unknown;
  readonly agents: AgentSet;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly userId?: string;
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface WorkflowDefinition {
  readonly name: string;
  readonly options: WorkflowOptions;
  dispatch(input: unknown, trigger?: string): Promise<RunRecord>;
}

type WorkflowHandler = (ctx: WorkflowContext) => Promise<unknown>;

/**
 * Define a workflow — a root-task handler that composes agent invocations
 * and deterministic steps into a durable pipeline.
 *
 * The handler receives a `WorkflowContext` with `ctx.agents` (run-scoped)
 * and `ctx.step(name, fn)` for memoized side effects. Determinism is the
 * author's contract: side effects must live in `ctx.step` or `agent.task()`.
 *
 * Default `retries: 0` — durability comes from child task runs + event
 * log replay, not blind handler re-runs.
 */
export function workflow(handler: WorkflowHandler): WorkflowDefinition;
export function workflow(opts: WorkflowOptions, handler: WorkflowHandler): WorkflowDefinition;
export function workflow(
  optsOrHandler: WorkflowOptions | WorkflowHandler,
  maybeHandler?: WorkflowHandler,
): WorkflowDefinition {
  const opts: WorkflowOptions = typeof optsOrHandler === "function" ? {} : optsOrHandler;
  const handler: WorkflowHandler = typeof optsOrHandler === "function"
    ? optsOrHandler
    : (maybeHandler ?? (() => { throw new Error("workflow() requires a handler function"); }));

  if (!handler || typeof handler !== "function") {
    throw new Error("workflow() requires a handler function");
  }

  const resolvedOpts: WorkflowOptions = {
    retries: 0,
    ...opts,
  };

  let boundRuntime: AgentRuntime | undefined;
  let boundName = opts.name ?? "unnamed";

  const definition: WorkflowDefinition = {
    get name() { return boundName; },
    get options() { return resolvedOpts; },

    async dispatch(input: unknown, trigger?: string): Promise<RunRecord> {
      if (!boundRuntime) {
        throw new Error(
          `Workflow "${boundName}" is not bound to a runtime. ` +
          `Call bindWorkflow(definition, runtime) before dispatch.`,
        );
      }
      const runId = randomUUID();
      const store = boundRuntime.store;

      await store.events.append(
        buildEventRecord(runId, {
          type: "run.started",
          input,
          trigger,
        }, { agentName: boundName, spanId: runId }),
      );

      // Run the handler to completion in-process. (In production the workflow
      // service registers this as a root task with its own durability; locally
      // we await so the returned RunRecord reflects the terminal state instead
      // of racing the handler and swallowing its errors.)
      try {
        await executeHandler(handler, {
          runId,
          trigger: trigger ?? "api",
          input,
          runtime: boundRuntime,
          workflowName: boundName,
          signal: new AbortController().signal,
        });
      } catch {
        // Terminal state (run.failed) is recorded in executeHandler; surface it
        // via the returned RunRecord rather than throwing from dispatch.
      }

      const run = await store.getRun(runId);
      return run ?? {
        id: runId,
        workflow: boundName,
        status: "running",
        totalCostUsd: 0,
        startedAt: new Date().toISOString(),
        input,
        trigger,
      };
    },
  };

  // Attach binding metadata for the runtime to wire up
  (definition as WorkflowDefinitionInternal).__bind = (name: string, runtime: AgentRuntime) => {
    boundName = name;
    boundRuntime = runtime;
  };

  return definition;
}

export interface WorkflowDefinitionInternal extends WorkflowDefinition {
  __bind(name: string, runtime: AgentRuntime): void;
}

/**
 * Bind a workflow to a runtime and give it its discovered name.
 * Called by the workflow loader at startup.
 */
export function bindWorkflow(def: WorkflowDefinition, name: string, runtime: AgentRuntime): void {
  (def as WorkflowDefinitionInternal).__bind(name, runtime);
}

// --- Handler execution with WorkflowContext ---

interface ExecuteOpts {
  runId: string;
  trigger: string;
  input: unknown;
  runtime: AgentRuntime;
  workflowName: string;
  signal: AbortSignal;
  userId?: string;
}

async function executeHandler(handler: WorkflowHandler, opts: ExecuteOpts): Promise<void> {
  const { runId, runtime, workflowName } = opts;
  const store = runtime.store;
  const completedSteps = new Map<string, unknown>();
  const usedStepNames = new Set<string>();

  // Pre-load completed steps for replay
  const existingEvents = await store.events.read(runId);
  for (const event of existingEvents) {
    if (event.payload.type === "step.completed") {
      completedSteps.set(event.payload.name, event.payload.result);
    }
  }

  const emit = async (event: RunEvent): Promise<void> => {
    await store.events.append(
      buildEventRecord(runId, event, { agentName: workflowName }),
    );
  };

  // Per-agent call ordinals make child run ids deterministic so a handler
  // replay (after crash/pause) re-dispatches to the same child run and reuses
  // its memoized result instead of duplicating work.
  const callOrdinals = new Map<string, number>();
  const nextOrdinal = (name: string): number => {
    const n = callOrdinals.get(name) ?? 0;
    callOrdinals.set(name, n + 1);
    return n;
  };

  const ctx: WorkflowContext = {
    runId,
    trigger: opts.trigger,
    input: opts.input,
    agents: createRunScopedAgentSet(runtime, runId, nextOrdinal),
    tracer: runtime.tracer,
    logger: { debug: console.debug, info: console.info, warn: console.warn, error: console.error },
    signal: opts.signal,
    userId: opts.userId,

    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (usedStepNames.has(name)) {
        throw new Error(
          `Duplicate ctx.step name "${name}" in workflow "${workflowName}". ` +
          `Step names must be unique within a single handler execution.`,
        );
      }
      usedStepNames.add(name);

      // Memoization: return stored result on re-execution
      if (completedSteps.has(name)) {
        return completedSteps.get(name) as T;
      }

      await emit({ type: "step.started", name });
      try {
        const result = await fn();
        await emit({ type: "step.completed", name, result: result as unknown });
        completedSteps.set(name, result);
        return result;
      } catch (err) {
        await emit({
          type: "run.failed",
          error: `Step "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        throw err;
      }
    },
  };

  try {
    const result = await handler(ctx);
    await emit({ type: "run.completed", result });
  } catch (err) {
    // Only emit run.failed if it hasn't been emitted already (e.g. by a step failure)
    const events = await store.events.read(runId);
    const alreadyFailed = events.some(e => e.payload.type === "run.failed");
    if (!alreadyFailed) {
      await emit({ type: "run.failed", error: err instanceof Error ? err.message : String(err) });
    }
    throw err;
  }
}

// --- Run-scoped AgentSet ---

function createRunScopedAgentSet(
  runtime: AgentRuntime,
  parentRunId: string,
  nextOrdinal: (name: string) => number,
): AgentSet {
  return {
    get(id: string | string[]): Agent | Agent[] {
      if (Array.isArray(id)) {
        return id.map(name => createRunScopedAgent(name, runtime, parentRunId, nextOrdinal));
      }
      return createRunScopedAgent(id as string, runtime, parentRunId, nextOrdinal);
    },
    has(id: string): boolean {
      return runtime.agentDefinitions.has(id);
    },
    all(): Agent[] {
      return [...runtime.agentDefinitions.keys()].map((name) =>
        createRunScopedAgent(name, runtime, parentRunId, nextOrdinal),
      );
    },
  } as AgentSet;
}

function resolveScopedDefinition(name: string, runtime: AgentRuntime): AgentDefinition {
  const def = runtime.agentDefinitions.get(name);
  if (!def) {
    throw new Error(
      `Agent "${name}" not found in the runtime. Ensure it was loaded via loadAgents() ` +
      `before the workflow runs.`,
    );
  }
  return def;
}

function createRunScopedAgent(
  name: string,
  runtime: AgentRuntime,
  parentRunId: string,
  nextOrdinal: (name: string) => number,
): Agent {
  return {
    name,
    get definition(): AgentDefinition {
      return resolveScopedDefinition(name, runtime);
    },
    // `.run()` executes in-process within the workflow's span tree; `.task()`
    // dispatches an isolated (durable, memoized) child run. Both use a
    // deterministic child run id derived from the parent run + call ordinal so
    // workflow replay is idempotent.
    async run<T>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>> {
      const def = resolveScopedDefinition(name, runtime);
      const childRunId = opts?.runId ?? idempotencyKey(parentRunId, `run:${name}:${nextOrdinal(name)}`);
      return runAgentInProcess<T>(def, input, {
        store: runtime.store,
        tracer: runtime.tracer,
        runners: runtime.runners,
        contextManager: runtime.contextManager,
        cancelStore: runtime.cancelStore,
        toolSources: runtime.toolSources,
        getDefinition: (n) => runtime.agentDefinitions.get(n),
        childDispatcher: runtime.dispatcher ?? inlineWorkflowDispatcher(runtime),
        delegation: runtime.delegation,
      }, {
        runId: childRunId,
        parentSpanId: parentRunId,
        userId: undefined,
        signal: opts?.signal,
      });
    },
    async task<T>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>> {
      resolveScopedDefinition(name, runtime);
      const dispatcher = runtime.dispatcher ?? inlineWorkflowDispatcher(runtime);
      const runId = opts?.runId ?? idempotencyKey(parentRunId, `task:${name}:${nextOrdinal(name)}`);
      return dispatcher.dispatch(name, input, {
        runId,
        parentSpanId: parentRunId,
        idempotencyKey: runId,
        plan: runtime.agentDefinitions.get(name)?.plan,
        signal: opts?.signal,
      }) as Promise<AgentOutput<T>>;
    },
  };
}

/** In-process dispatcher fallback for workflows whose runtime lacks one. */
function inlineWorkflowDispatcher(runtime: AgentRuntime): NonNullable<AgentRuntime["dispatcher"]> {
  return {
    dispatch(name: string, input: AgentInput, dOpts) {
      const def = resolveScopedDefinition(name, runtime);
      return runAgentInProcess(def, input, {
        store: runtime.store,
        tracer: runtime.tracer,
        runners: runtime.runners,
        contextManager: runtime.contextManager,
        cancelStore: runtime.cancelStore,
        toolSources: runtime.toolSources,
        getDefinition: (n) => runtime.agentDefinitions.get(n),
        childDispatcher: inlineWorkflowDispatcher(runtime),
        delegation: runtime.delegation,
      }, {
        runId: dOpts.runId,
        parentSpanId: dOpts.parentSpanId,
        userId: dOpts.userId,
        depth: dOpts.depth,
        signal: dOpts.signal,
      });
    },
  };
}

// --- Webhook adapter types (unchanged, re-exported) ---

export interface WebhookAdapter {
  readonly name: string;
  match(req: Request): WebhookMatch | null;
  parse(req: Request): Promise<unknown>;
}

export interface WebhookMatch {
  workflow: string;
  trigger: string;
}
