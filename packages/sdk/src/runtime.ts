import type {
  RunStore,
  Tracer,
} from "@render-agents/store";
import { createMemoryStore } from "@render-agents/store";
import type {
  ModelClient,
  CompleteArgs,
  CompleteResult,
  AgentRunner,
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
import { DefaultRunner, passThroughContextManager } from "@render-agents/engine";

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
}

export interface CreateRuntimeOptions {
  store?: RunStore;
  tracer?: Tracer;
  model?: ModelClient;
  pricing?: Record<string, ModelPricing>;
  retry?: Partial<RetryPolicy>;
  runners?: RunnerRegistry;
  dispatcher?: TaskDispatcher;
  delegation?: Partial<DelegationLimits>;
  hooks?: Hook[];
  contextManager?: ContextManager;
}

/** A no-op tracer. Span/trace tree is a projection of the event log; OTel export is layered on later (Sprint 10). */
const noopTracer: Tracer = {
  onStart: () => {},
  onEnd: () => {},
};

/**
 * Placeholder model used when none is provided and none can be inferred from the
 * environment. Returning a runtime is always safe (Wave 0 exit criterion); the
 * error only surfaces if an agent is actually run without a configured model.
 * Real provider clients are wired in Sprint 06.
 */
const unconfiguredModel: ModelClient = {
  async complete(_args: CompleteArgs): Promise<CompleteResult> {
    throw new Error(
      "No model configured. Pass one via createRuntime({ model }) (e.g. mockModel in tests), " +
        "or set a provider API key once real model clients land (Sprint 06).",
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
 * Builds the composition root (D5). Each dependency is an optional override;
 * Wave 0 defaults to an in-memory store and an in-process fallback (no
 * dispatcher, so `.task()` runs as `.run()`). Postgres detection and real model
 * clients are wired in later sprints.
 */
export async function createRuntime(opts?: CreateRuntimeOptions): Promise<AgentRuntime> {
  const store: RunStore = opts?.store ?? createMemoryStore();
  await store.init();

  const tracer = opts?.tracer ?? noopTracer;
  const model = opts?.model ?? unconfiguredModel;
  const contextManager = opts?.contextManager ?? passThroughContextManager;
  const hooks = buildHookRegistry(opts?.hooks ?? []);
  const runners = opts?.runners ?? buildRunnerRegistry(model, opts?.pricing);

  return {
    store,
    tracer,
    model,
    runners,
    hooks,
    contextManager,
    dispatcher: opts?.dispatcher,
  };
}
