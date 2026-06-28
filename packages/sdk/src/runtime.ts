import type {
  RunStore,
  Tracer,
  CancelStore,
} from "@render-agents/store";
import { createStore, MemoryCancelStore } from "@render-agents/store";
import type {
  ModelClient,
  CompleteArgs,
  CompleteResult,
  AgentRunner,
  AgentDefinition,
  Hook,
  HookRegistry,
  ContextManager,
  DelegationLimits,
  AgentInput,
  AgentOutput,
  RenderPlan,
  RetryPolicy,
  ModelPricing,
} from "@render-agents/engine";
import { DefaultRunner, passThroughContextManager, DefaultContextManager, resolveClient, resolveModelSpec, noopTracer, buildHookInterceptor } from "@render-agents/engine";
import { RenderWorkflowsDispatcher, InProcessDispatcher, isWorkflowsEnvironment } from "./dispatch.js";

export interface RunnerRegistry {
  get(name: string): AgentRunner;
  has(name: string): boolean;
}

export interface DispatchOptions {
  runId: string;
  parentSpanId?: string;
  userId?: string;
  depth?: number;
  idempotencyKey: string;
  plan?: RenderPlan;
  signal?: AbortSignal;
}

export interface TaskDispatcher {
  dispatch(agentName: string, input: AgentInput, opts: DispatchOptions): Promise<AgentOutput>;
}

export interface AgentRuntime {
  readonly store: RunStore;
  readonly tracer: Tracer;
  readonly model: ModelClient;
  readonly runners: RunnerRegistry;
  readonly hooks: HookRegistry;
  readonly contextManager: ContextManager;
  readonly dispatcher?: TaskDispatcher;
  /** Cooperative cancellation store, shared across in-process runs/dispatch. */
  readonly cancelStore: CancelStore;
  /** Loaded agent definitions keyed by name. Populated by `loadAgents`; used by the dispatcher and subagent delegation. */
  readonly agentDefinitions: Map<string, AgentDefinition>;
  /** Optional delegation limits (depth/fanout) for subagents. */
  readonly delegation?: Partial<DelegationLimits>;
  /** Resolved tool sources from the tools/ directory, keyed by source id. */
  readonly toolSources: Map<string, import("@render-agents/engine").ToolSource>;
}

export interface CreateRuntimeOptions {
  store?: RunStore;
  tracer?: Tracer;
  model?: ModelClient;
  pricing?: Record<string, ModelPricing>;
  retry?: Partial<RetryPolicy>;
  runners?: RunnerRegistry;
  dispatcher?: TaskDispatcher;
  cancelStore?: CancelStore;
  delegation?: Partial<DelegationLimits>;
  hooks?: Hook[];
  contextManager?: ContextManager;
  /** Pre-resolved tool sources, keyed by source id. When provided (e.g. from the loader), agents can mount tools at run time. */
  toolSources?: Map<string, import("@render-agents/engine").ToolSource>;
}

/**
 * Attempt to auto-detect a model client from environment variables.
 * Falls back to the unconfigured placeholder when no API key is found.
 */
function detectModel(retry?: Partial<RetryPolicy>): ModelClient {
  if (process.env.ANTHROPIC_API_KEY) {
    const { spec } = resolveModelSpec("medium");
    return resolveClient(spec, { retry });
  }
  if (process.env.OPENAI_API_KEY) {
    return resolveClient({ provider: "openai", model: "gpt-4o" }, { retry });
  }
  return unconfiguredModel;
}

/**
 * Placeholder model used when none is provided and no API key is detected.
 * The error only surfaces if an agent is actually run without a configured model.
 */
const unconfiguredModel: ModelClient = {
  async complete(_args: CompleteArgs): Promise<CompleteResult> {
    throw new Error(
      "No model configured. Pass one via createRuntime({ model }) (e.g. mockModel in tests), " +
        "or set ANTHROPIC_API_KEY / OPENAI_API_KEY to enable auto-detection.",
    );
  },
};

function buildHookRegistry(hooks: Hook[]): HookRegistry {
  const byName = new Map<string, Hook>();
  for (const hook of hooks) byName.set(hook.name, hook);
  return {
    get(name: string): Hook {
      const hook = byName.get(name);
      if (!hook) throw new Error(`Hook "${name}" not found`);
      return hook;
    },
    has: (name: string) => byName.has(name),
    ids: () => [...byName.keys()],
  };
}

function buildRunnerRegistry(model: ModelClient, pricing?: Record<string, ModelPricing>): RunnerRegistry {
  const defaultRunner = new DefaultRunner(model, { pricing });
  return {
    get(name: string): AgentRunner {
      if (name === "default") return defaultRunner;
      throw new Error(`Runner "${name}" not found`);
    },
    has: (name: string) => name === "default",
  };
}

/**
 * Detect whether a Render Workflows dispatcher should be used.
 * Returns a dispatcher for production, undefined for local dev/test.
 */
function detectDispatcher(): TaskDispatcher | undefined {
  if (!isWorkflowsEnvironment()) return undefined;
  const slug = process.env.RENDER_WORKFLOW_SLUG ?? "default";
  return new RenderWorkflowsDispatcher({ workflowSlug: slug });
}

/**
 * Builds the composition root (D5). Each dependency is an optional override;
 * Wave 0 defaults to an in-memory store and an in-process fallback (no
 * dispatcher, so `.task()` runs as `.run()`). Postgres detection and real model
 * clients are wired in later sprints.
 */
export async function createRuntime(opts?: CreateRuntimeOptions): Promise<AgentRuntime> {
  const store: RunStore = opts?.store ?? createStore();
  await store.init();

  const tracer = opts?.tracer ?? noopTracer;
  const model = opts?.model ?? detectModel(opts?.retry);
  const contextManager = opts?.contextManager ?? (
    model !== unconfiguredModel
      ? new DefaultContextManager({ model })
      : passThroughContextManager
  );
  const hooks = buildHookRegistry(opts?.hooks ?? []);
  const runners = opts?.runners ?? buildRunnerRegistry(model, opts?.pricing);
  const cancelStore = opts?.cancelStore ?? new MemoryCancelStore();
  const agentDefinitions = new Map<string, AgentDefinition>();
  const toolSources = opts?.toolSources ?? new Map();

  // `.task()` always runs through a dispatcher: the Render Workflows dispatcher
  // in production, otherwise an in-process dispatcher that provides identical
  // observable behavior (events/spans/output + idempotent re-dispatch) minus
  // container isolation. Tests can still pass an explicit dispatcher override.
  const dispatcher = opts?.dispatcher
    ?? detectDispatcher()
    ?? new InProcessDispatcher({
      store,
      runners,
      model,
      contextManager,
      cancelStore,
      toolSources,
      delegation: opts?.delegation,
      getDefinition: (name) => agentDefinitions.get(name),
    });

  // Inject hook interceptor into the store's append pipeline
  if (hooks.ids().length > 0 && "setInterceptor" in store) {
    const consoleLogger = { debug: () => {}, info: () => {}, warn: console.warn, error: console.error };
    const interceptor = buildHookInterceptor(hooks, consoleLogger, (name) => process.env[name]);
    (store as { setInterceptor: (i: unknown) => void }).setInterceptor(interceptor);
  }

  return {
    store,
    tracer,
    model,
    runners,
    hooks,
    contextManager,
    dispatcher,
    cancelStore,
    agentDefinitions,
    delegation: opts?.delegation,
    toolSources,
  };
}
