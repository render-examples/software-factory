import type {
  RunStore,
  Tracer,
} from "@render-agents/store";
import type {
  ModelClient,
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

export function createRuntime(_opts?: CreateRuntimeOptions): Promise<AgentRuntime> {
  throw new Error("not implemented");
}
