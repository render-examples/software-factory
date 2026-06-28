import { randomUUID } from "node:crypto";
import type {
  Logger,
  Tracer,
  RunRecord,
  RunEvent,
} from "@render-agents/store";
import { buildEventRecord } from "@render-agents/store";
import type {
  RenderPlan,
  AgentDefinition,
  AgentInput,
  AgentOutput,
  RunOptions,
} from "@render-agents/engine";
import type { AgentSet, Agent } from "./agents.js";
import type { AgentRuntime } from "./runtime.js";

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

      // Execute the handler (in-process for now; production registers as root task)
      executeHandler(handler, {
        runId,
        trigger: trigger ?? "api",
        input,
        runtime: boundRuntime,
        workflowName: boundName,
        signal: new AbortController().signal,
      }).catch(() => {
        // errors are recorded via run.failed in executeHandler
      });

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

  const ctx: WorkflowContext = {
    runId,
    trigger: opts.trigger,
    input: opts.input,
    agents: createRunScopedAgentSet(runtime, runId),
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

function createRunScopedAgentSet(runtime: AgentRuntime, parentRunId: string): AgentSet {
  const allDefs = runtime.toolSources; // placeholder — real agent definitions from runtime
  void allDefs;
  void parentRunId;

  // The run-scoped AgentSet wraps the runtime's agents with run context
  // (parentSpanId, userId propagation). For now, return a proxy that
  // binds agents to the current run's span tree on access.
  return {
    get(id: string | string[]): Agent | Agent[] {
      if (Array.isArray(id)) {
        return id.map(name => createRunScopedAgent(name, runtime, parentRunId));
      }
      return createRunScopedAgent(id as string, runtime, parentRunId);
    },
    has(_id: string): boolean {
      return true; // validated at load time
    },
    all(): Agent[] {
      return []; // full enumeration not typically needed in workflow handlers
    },
  } as AgentSet;
}

function createRunScopedAgent(
  name: string,
  runtime: AgentRuntime,
  parentRunId: string,
): Agent {
  return {
    name,
    get definition(): AgentDefinition {
      throw new Error(
        `Use ctx.agents.get("${name}").run() or .task() to invoke agents. ` +
        `Direct definition access is not supported in workflow context.`,
      );
    },
    async run<T>(_input: AgentInput, _opts?: RunOptions): Promise<AgentOutput<T>> {
      // Run-scoped agents in workflow context should use .task() for isolation.
      // Direct .run() requires the runtime to expose loaded definitions, which
      // is wired when the runtime caches its AgentSet at startup.
      throw new Error(
        `Run-scoped agent "${name}" requires the runtime to expose loaded definitions. ` +
        `Use agent.task() for isolated dispatch, or load agents outside the handler.`,
      );
    },
    async task<T>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>> {
      if (!runtime.dispatcher) {
        throw new Error(
          `agent.task() requires a dispatcher. In workflow handlers, ` +
          `ensure the runtime has a configured dispatcher.`,
        );
      }
      const runId = opts?.runId ?? randomUUID();
      return runtime.dispatcher.dispatch(name, input, {
        runId,
        parentSpanId: parentRunId,
        idempotencyKey: `${parentRunId}:${name}:${runId}`,
        signal: opts?.signal,
      }) as Promise<AgentOutput<T>>;
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
