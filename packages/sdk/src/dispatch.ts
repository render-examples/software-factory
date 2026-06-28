import { createHash } from "node:crypto";
import type { RunStore } from "@render-agents/store";
import type {
  AgentDefinition,
  AgentInput,
  AgentOutput,
  RenderPlan,
  ModelClient,
  ContextManager,
} from "@render-agents/engine";
import { InProcessRunContext } from "@render-agents/engine";
import type { AgentRuntime, TaskDispatcher, DispatchOptions, RunnerRegistry } from "./runtime.js";

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
  toolSources: Map<string, import("@render-agents/engine").ToolSource>;
  getDefinition: (name: string) => AgentDefinition | undefined;
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

  async dispatch(agentName: string, input: AgentInput, dispatchOpts: DispatchOptions): Promise<AgentOutput> {
    assertSerializable(input, `Task input for agent "${agentName}"`);

    // Idempotent re-dispatch: check if we already have a completed child run
    const existing = await this.lookupExistingResult(dispatchOpts.idempotencyKey);
    if (existing) return existing;

    const definition = this.opts.getDefinition(agentName);
    if (!definition) {
      throw new Error(
        `InProcessDispatcher: agent "${agentName}" not found. ` +
        `Ensure the agent is loaded before dispatching.`,
      );
    }

    const runId = dispatchOpts.runId;
    const runner = this.opts.runners.get(definition.runner ?? "default");
    const ctx = new InProcessRunContext({
      runId,
      store: this.opts.store,
      tracer: { onStart: () => {}, onEnd: () => {} },
      model: definition.model,
      agentName: definition.name,
      contextManager: this.opts.contextManager,
      signal: dispatchOpts.signal ?? new AbortController().signal,
      parentSpanId: dispatchOpts.parentSpanId,
      userId: dispatchOpts.userId,
      depth: (dispatchOpts.depth ?? 0) + 1,
      maxContextTokens: definition.context?.maxContextTokens,
      toolSources: this.opts.toolSources,
    });

    const result = await runner.run(definition, input, ctx);
    assertSerializable(result, `Task output from agent "${agentName}"`);
    return result;
  }

  /**
   * Look up a previously completed child run by its dispatch idempotency key.
   * Returns the AgentOutput if found, undefined otherwise.
   */
  private async lookupExistingResult(idempotencyKey: string): Promise<AgentOutput | undefined> {
    // The idempotency key for task dispatch is stored as a step result
    // in the parent run's workflow_steps projection (key = dispatch key).
    // This allows re-execution to short-circuit.
    // For now, return undefined — full memoization requires the parent
    // run context, which is wired in Sprint 12 (ctx.step).
    void idempotencyKey;
    return undefined;
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
      depth: opts.depth ?? 0,
      idempotencyKey: opts.idempotencyKey,
    };

    assertSerializable(taskInput, `Serialized task payload for "${agentName}"`);

    // Dynamic import to avoid hard dependency on @renderinc/sdk in dev
    const { Render } = await importRenderSdk();
    const client = Render();
    const result = await client.workflows.runTask(taskSlug, [taskInput]);

    if (!result || typeof result !== "object") {
      throw new Error(
        `RenderWorkflowsDispatcher: task "${taskSlug}" returned invalid result`,
      );
    }

    return result as AgentOutput;
  }
}

async function importRenderSdk(): Promise<{ Render: () => { workflows: { runTask: (slug: string, args: unknown[]) => Promise<unknown> } } }> {
  try {
    // Dynamic import with variable to prevent TypeScript from resolving the module at build time
    const moduleName = "@renderinc/sdk";
    return await (Function("m", "return import(m)")(moduleName)) as never;
  } catch {
    throw new Error(
      "RenderWorkflowsDispatcher requires @renderinc/sdk. " +
      "Install it or use InProcessDispatcher for local development.",
    );
  }
}

// --- Task handler (runs in workflow service container) ---

export interface AgentTaskInput {
  agentName: string;
  input: AgentInput;
  runId: string;
  parentSpanId?: string;
  userId?: string;
  depth: number;
  idempotencyKey: string;
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
  const { agentName, input, runId, parentSpanId, userId, depth } = taskInput;

  const definition = getDefinition(agentName);
  if (!definition) {
    throw new Error(
      `agentTaskHandler: agent "${agentName}" not found in deployed image. ` +
      `Ensure the agent markdown file exists and is loadable.`,
    );
  }

  const runner = runtime.runners.get(definition.runner ?? "default");
  const ctx = new InProcessRunContext({
    runId,
    store: runtime.store,
    tracer: runtime.tracer,
    model: definition.model,
    agentName: definition.name,
    contextManager: runtime.contextManager,
    signal: new AbortController().signal,
    parentSpanId,
    userId,
    depth: depth + 1,
    maxContextTokens: definition.context?.maxContextTokens,
    toolSources: runtime.toolSources,
  });

  return runner.run(definition, input, ctx);
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
 * Present when running inside a Render Workflow service container.
 */
export function isWorkflowsEnvironment(): boolean {
  return !!(process.env.RENDER_SDK_SOCKET_PATH || process.env.RENDER_USE_LOCAL_DEV);
}
