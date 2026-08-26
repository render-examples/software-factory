import { randomUUID } from "node:crypto";
import type {
  Logger,
  Tracer,
  RunRecord,
  RunEvent,
  ThreadStore,
} from "@render-factory/store";
import { buildEventRecord, idempotencyKey } from "@render-factory/store";
import type {
  RenderPlan,
  AgentDefinition,
  AgentInput,
  AgentOutput,
  RunOptions,
} from "@render-factory/engine";
import { RunPaused, RunCancelled } from "@render-factory/engine";
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
  readonly runtime: AgentRuntime;
  readonly threadStore: ThreadStore;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly userId?: string;
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface WorkflowDispatchOptions {
  threadId?: string;
  userId?: string;
}

export interface WorkflowDefinition {
  readonly name: string;
  readonly options: WorkflowOptions;
  dispatch(input: unknown, trigger?: string, opts?: WorkflowDispatchOptions): Promise<RunRecord>;
  /**
   * Drive (or re-drive) the handler for an *already-started* run, recovering
   * input/trigger/identity from the run record. Unlike `dispatch`, this does not
   * emit `run.started` or generate a run id — the runner uses it to execute a
   * claimed `workflow` job and to re-drive a crashed run (idempotent via
   * `ctx.step` memoization + deterministic child dispatch keys). Throws
   * `RunPaused` if a child run parks the handler.
   */
  drive(runId: string, opts?: { signal?: AbortSignal }): Promise<void>;
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

    async dispatch(input: unknown, trigger?: string, dispatchOpts?: WorkflowDispatchOptions): Promise<RunRecord> {
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
          threadId: dispatchOpts?.threadId,
          userId: dispatchOpts?.userId,
          spanKind: "workflow",
        }, { agentName: boundName, spanId: runId }),
      );

      // Trigger Lane A (workflow lane) via the dispatcher's root seam,
      // fire-and-forget: `RenderWorkflowsDispatcher` starts a durable task and
      // returns immediately; `InProcessDispatcher` drives to rest in-process
      // (dev/test). No `run_jobs` row for workflows — Render is the queue.
      const dispatcher = boundRuntime.dispatcher;
      if (dispatcher?.dispatchRoot) {
        // Fail-fast (E6): if hand-off to Lane A throws synchronously (host
        // down), record `run.failed` instead of leaving the run stuck
        // `running` forever. (Host-accepts-but-never-completes case is
        // caught separately by the run reaper.)
        try {
          await dispatcher.dispatchRoot({ workflow: boundName, runId, plan: resolvedOpts.plan });
        } catch (err) {
          const detail = err instanceof Error
            ? (err.cause ? `${err.message} | cause: ${JSON.stringify(err.cause)}` : err.message)
            : JSON.stringify(err);
          await store.events.append(
            buildEventRecord(
              runId,
              { type: "run.failed", error: `failed to dispatch root to workflows host: ${detail}` },
              { agentName: boundName, spanId: runId },
            ),
          );
          return (await store.getRun(runId)) ?? {
            id: runId,
            workflow: boundName,
            status: "failed",
            kind: "interactive" as const,
            totalCostUsd: 0,
            startedAt: new Date().toISOString(),
            input,
            trigger,
          };
        }
      } else {
        // No root-capable dispatcher: drive in-proc. executeHandler records
        // terminal/paused state; never throw out of dispatch.
        try {
          await definition.drive(runId);
        } catch {
          /* terminal/paused recorded on the run */
        }
      }

      return (await store.getRun(runId)) ?? {
        id: runId,
        workflow: boundName,
        status: "running",
        kind: "interactive" as const,
        totalCostUsd: 0,
        startedAt: new Date().toISOString(),
        input,
        trigger,
      };
    },

    async drive(runId: string, driveOpts?: { signal?: AbortSignal }): Promise<void> {
      if (!boundRuntime) {
        throw new Error(
          `Workflow "${boundName}" is not bound to a runtime. ` +
          `Call bindWorkflow(definition, runtime) before drive.`,
        );
      }
      // Run already exists (gateway emitted `run.started` at enqueue); recover
      // orchestration inputs from it. Handler is replay-safe, so a re-drive
      // after a crash resumes from memoized steps.
      const run = await boundRuntime.store.getRun(runId);
      if (!run) {
        throw new Error(`Workflow "${boundName}" drive: run "${runId}" not found`);
      }
      await executeHandler(handler, {
        runId,
        trigger: run.trigger ?? "api",
        input: run.input,
        runtime: boundRuntime,
        workflowName: boundName,
        signal: driveOpts?.signal ?? new AbortController().signal,
        threadId: run.threadId,
        userId: run.userId,
      });
    },
  };

  // Binding metadata for the runtime to wire up
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
  // Register so dispatchRoot and HITL resume routing can resolve it by name.
  runtime.workflows.set(name, def);
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
  threadId?: string;
}

export async function executeHandler(handler: WorkflowHandler, opts: ExecuteOpts): Promise<void> {
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

  // Trace tree: workflow root span (spanId = runId) closes on the terminal
  // lifecycle event; each `ctx.step` is a `step`-kind span nested under it.
  // Step span ids are deterministic per name so replay reuses them.
  const spanFor = (event: RunEvent): { spanId?: string; parentSpanId?: string } => {
    switch (event.type) {
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
      case "run.paused":
        return { spanId: runId };
      case "step.started":
      case "step.completed":
        return { spanId: idempotencyKey(runId, `step-span:${event.name}`), parentSpanId: runId };
      default:
        return {};
    }
  };

  const emit = async (event: RunEvent): Promise<void> => {
    await store.events.append(
      buildEventRecord(runId, event, { agentName: workflowName, ...spanFor(event) }),
    );
  };

  // Cooperative cancellation (E3): poll the cancel store at orchestration
  // boundaries so the handler stops and records `run.cancelled` instead of
  // running to completion and overwriting the cancelled status.
  const throwIfCancelled = async (): Promise<void> => {
    if (await runtime.cancelStore.isCancelled(runId)) throw new RunCancelled(runId);
  };
  const emitCancelledOnce = async (): Promise<void> => {
    const events = await store.events.read(runId);
    const terminal = events.some(
      (e) => e.payload.type === "run.completed" || e.payload.type === "run.failed" || e.payload.type === "run.cancelled",
    );
    if (!terminal) await emit({ type: "run.cancelled" });
  };

  // Per-agent call ordinals make child run ids deterministic so replay
  // re-dispatches to the same child run and reuses its memoized result.
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
    agents: createRunScopedAgentSet(runtime, runId, nextOrdinal, { threadId: opts.threadId, userId: opts.userId }),
    runtime,
    threadStore: runtime.threadStore,
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

      if (completedSteps.has(name)) {
        return completedSteps.get(name) as T;
      }

      await throwIfCancelled();

      await emit({ type: "step.started", name });
      try {
        const result = await fn();
        await emit({ type: "step.completed", name, result: result as unknown });
        completedSteps.set(name, result);
        return result;
      } catch (err) {
        // HITL park unwinds through the step but isn't a step failure —
        // propagate so the root parks as paused.
        if (err instanceof RunPaused) throw err;
        await emit({
          type: "run.failed",
          error: `Step "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        throw err;
      }
    },
  };

  try {
    await throwIfCancelled();
    const result = await handler(ctx);
    // Honor a cancel that landed while finishing: prefer `run.cancelled`
    // over `run.completed` so cancellation isn't lost.
    if (await runtime.cancelStore.isCancelled(runId)) {
      await emitCancelledOnce();
      return;
    }
    await emit({ type: "run.completed", result });
  } catch (err) {
    if (err instanceof RunCancelled) {
      // Root (or its scope) was cancelled; record terminal state and rethrow
      // so the task layer settles it as cancelled, not failed.
      await emitCancelledOnce();
      throw err;
    }
    if (err instanceof RunPaused) {
      // A child paused (awaiting approval/input); park the root as `paused`
      // (resumable by replay) and rethrow so the runner marks the job done.
      await emit({ type: "run.paused", reason: err.reason, pendingInputIds: err.pendingInputIds });
      throw err;
    }
    // Avoid double-emitting run.failed if a step failure already emitted it
    const events = await store.events.read(runId);
    const alreadyFailed = events.some(e => e.payload.type === "run.failed");
    if (!alreadyFailed) {
      await emit({ type: "run.failed", error: err instanceof Error ? err.message : String(err) });
    }
    throw err;
  }
}

// --- Run-scoped AgentSet ---

interface ScopedIdentity {
  threadId?: string;
  userId?: string;
}

function createRunScopedAgentSet(
  runtime: AgentRuntime,
  parentRunId: string,
  nextOrdinal: (name: string) => number,
  identity: ScopedIdentity,
): AgentSet {
  return {
    get(id: string | string[]): Agent | Agent[] {
      if (Array.isArray(id)) {
        return id.map(name => createRunScopedAgent(name, runtime, parentRunId, nextOrdinal, identity));
      }
      return createRunScopedAgent(id as string, runtime, parentRunId, nextOrdinal, identity);
    },
    has(id: string): boolean {
      return runtime.agentDefinitions.has(id);
    },
    all(): Agent[] {
      return [...runtime.agentDefinitions.keys()].map((name) =>
        createRunScopedAgent(name, runtime, parentRunId, nextOrdinal, identity),
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
  identity: ScopedIdentity,
): Agent {
  return {
    name,
    get definition(): AgentDefinition {
      return resolveScopedDefinition(name, runtime);
    },
    // `.run()` executes in-process within the workflow's span tree; `.task()`
    // dispatches an isolated durable child run. Both derive a deterministic
    // child run id from parent + call ordinal for replay idempotency.
    async run<T>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>> {
      const def = resolveScopedDefinition(name, runtime);
      const childRunId = opts?.runId ?? idempotencyKey(parentRunId, `run:${name}:${nextOrdinal(name)}`);
      // Cancel cascade (E3): don't launch a child once the root is cancelled.
      if (await runtime.cancelStore.isCancelled(parentRunId)) throw new RunCancelled(childRunId, parentRunId);
      const memo = await memoizedChildOutput<T>(runtime, childRunId);
      if (memo) return memo;
      const out = await runAgentInProcess<T>(def, input, {
        store: runtime.store,
        tracer: runtime.tracer,
        runners: runtime.runners,
        contextManager: runtime.contextManager,
        cancelStore: runtime.cancelStore,
        toolSources: runtime.toolSources,
        getDefinition: (n) => runtime.agentDefinitions.get(n),
        childDispatcher: runtime.dispatcher ?? inlineWorkflowDispatcher(runtime),
        delegation: runtime.delegation,
        oauthStore: runtime.oauthStore,
        oauthRefreshers: runtime.oauthRefreshers,
        deltaBus: runtime.deltaBus,
        suspender: runtime.suspender,
      }, {
        runId: childRunId,
        parentSpanId: parentRunId,
        userId: identity.userId,
        threadId: identity.threadId,
        signal: opts?.signal,
        cancelScopeId: parentRunId,
      });
      if (await runtime.cancelStore.isCancelled(parentRunId)) throw new RunCancelled(childRunId, parentRunId);
      return out;
    },
    async task<T>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>> {
      resolveScopedDefinition(name, runtime);
      const dispatcher = runtime.dispatcher ?? inlineWorkflowDispatcher(runtime);
      const runId = opts?.runId ?? idempotencyKey(parentRunId, `task:${name}:${nextOrdinal(name)}`);
      if (await runtime.cancelStore.isCancelled(parentRunId)) throw new RunCancelled(runId, parentRunId);
      const memo = await memoizedChildOutput<T>(runtime, runId);
      if (memo) return memo;
      const out = await dispatcher.dispatch(name, input, {
        runId,
        parentSpanId: parentRunId,
        userId: identity.userId,
        threadId: identity.threadId,
        idempotencyKey: runId,
        plan: runtime.agentDefinitions.get(name)?.plan,
        signal: opts?.signal,
        cancelScopeId: parentRunId,
      }) as AgentOutput<T>;
      if (await runtime.cancelStore.isCancelled(parentRunId)) throw new RunCancelled(runId, parentRunId);
      return out;
    },
  };
}

/**
 * Workflow replay idempotency: a child run (`.run()`/`.task()`) that already
 * reached `completed` on a prior drive returns its memoized result instead of
 * being re-dispatched into the model loop. Re-driving a completed run would
 * re-run side effects and — since its transcript ends on an assistant turn —
 * fail the provider call ("conversation must end with a user message"). Only
 * `completed` short-circuits; a still-`paused` child is re-dispatched so a
 * now-resolved approval lets it proceed past the gate.
 */
async function memoizedChildOutput<T>(
  runtime: AgentRuntime,
  runId: string,
): Promise<AgentOutput<T> | undefined> {
  const run = await runtime.store.getRun(runId);
  if (!run || run.status !== "completed") return undefined;
  const result = run.result;
  const usage = { inputTokens: 0, outputTokens: 0 };
  return typeof result === "string"
    ? ({ text: result, usage } as AgentOutput<T>)
    : ({ text: "", data: result as T, usage } as AgentOutput<T>);
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
        oauthStore: runtime.oauthStore,
        oauthRefreshers: runtime.oauthRefreshers,
        deltaBus: runtime.deltaBus,
        suspender: runtime.suspender,
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

