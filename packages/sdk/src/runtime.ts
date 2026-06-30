import type {
  RunStore,
  Tracer,
  CancelStore,
  ThreadStore,
  Thread,
  ThreadMessage,
  OAuthStore,
  ScheduleStore,
  ScheduleRecord,
} from "@render-agents/store";
import type { JobQueue } from "@render-agents/store";
import { createStore, createJobQueue, MemoryCancelStore } from "@render-agents/store";
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
  OAuthRefresher,
} from "@render-agents/engine";
import { DefaultRunner, passThroughContextManager, DefaultContextManager, resolveClient, resolveModelSpec, noopTracer, buildHookInterceptor } from "@render-agents/engine";
import { RenderWorkflowsDispatcher, InProcessDispatcher, isWorkflowsEnvironment, isRootTriggerEnvironment } from "./dispatch.js";
import type { WorkflowDefinition } from "./workflow.js";

export interface RunnerRegistry {
  get(name: string): AgentRunner;
  has(name: string): boolean;
}

export interface DispatchOptions {
  runId: string;
  parentSpanId?: string;
  userId?: string;
  threadId?: string;
  depth?: number;
  idempotencyKey: string;
  plan?: RenderPlan;
  signal?: AbortSignal;
}

/**
 * A root-run trigger: hand the workflow lane (Lane A) a run that already exists
 * in the event log (the gateway emitted `run.started`). `dispatchRoot` is
 * fire-and-forget — it returns once the run is *triggered*, not once it
 * finishes. The dispatcher decides where the root executes:
 * - `InProcessDispatcher` drives `wf.drive(runId)` in-process (dev/test).
 * - `RenderWorkflowsDispatcher` calls `startTask("<slug>/workflow@<plan>", …)`.
 */
export interface RootDispatchJob {
  workflow: string;
  runId: string;
  plan?: RenderPlan;
}

export interface TaskDispatcher {
  /** Dispatch a child agent run (`agent.task()`): isolated, awaited result. */
  dispatch(agentName: string, input: AgentInput, opts: DispatchOptions): Promise<AgentOutput>;
  /**
   * Trigger a workflow *root* (Lane A). Optional so narrower dispatchers (e.g.
   * subagent-only) need not implement it; `workflow.dispatch()` falls back to an
   * in-process drive when it is absent.
   */
  dispatchRoot?(job: RootDispatchJob): Promise<void>;
}

/**
 * How root runs + resumes execute relative to their trigger:
 * - `inline` — the trigger runs the handler/agent/resume to a resting state in
 *   the calling process (today's behavior; no runner needed). Used by tests and
 *   the no-Postgres dev path.
 * - `queue` — the trigger records the opening event(s) and enqueues a durable
 *   job, returning immediately; a `runWorker` claims and drives it. Decouples
 *   ingestion from execution (webhook/cron latency, crash recovery, backpressure).
 *
 * `agent.task()` child dispatch is unaffected either way — it always goes through
 * `runtime.dispatcher`.
 */
export type ExecutionMode = "inline" | "queue";

export interface AgentRuntime {
  readonly store: RunStore;
  /** Thread metadata + transcript store. Defaults to the run store when it implements ThreadStore. */
  readonly threadStore: ThreadStore;
  /** OAuth connection store (per-user tokens). Defaults to the run store when it implements OAuthStore. */
  readonly oauthStore: OAuthStore;
  /** Runtime-managed schedule store. Defaults to the run store when it implements ScheduleStore. */
  readonly scheduleStore: ScheduleStore;
  /** Per-provider token refreshers, populated by the gateway from provider configs. */
  readonly oauthRefreshers: Map<string, OAuthRefresher>;
  readonly tracer: Tracer;
  readonly model: ModelClient;
  readonly runners: RunnerRegistry;
  readonly hooks: HookRegistry;
  readonly contextManager: ContextManager;
  readonly dispatcher?: TaskDispatcher;
  /** Durable job queue (control plane) for root-run + resume dispatch. Backed by Postgres when available, else in-memory. */
  readonly jobQueue: JobQueue;
  /** Whether root runs/resumes execute inline at the trigger or are enqueued for a runner. Default `inline`. */
  readonly executionMode: ExecutionMode;
  /** Cooperative cancellation store, shared across in-process runs/dispatch. */
  readonly cancelStore: CancelStore;
  /** Loaded agent definitions keyed by name. Populated by `loadAgents`; used by the dispatcher and subagent delegation. */
  readonly agentDefinitions: Map<string, AgentDefinition>;
  /**
   * Loaded workflow definitions keyed by name. Populated by `bindWorkflow` /
   * `loadWorkflows`; used by the in-process root dispatcher (`dispatchRoot`) and
   * the gateway's HITL resume routing to classify a paused root as a workflow.
   */
  readonly workflows: Map<string, WorkflowDefinition>;
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
  /** Custom runners discovered from `runners/` (keyed by name); merged with the built-in `default`. */
  extraRunners?: Map<string, AgentRunner>;
  dispatcher?: TaskDispatcher;
  jobQueue?: JobQueue;
  /** Execution mode for root runs/resumes. Defaults to `RENDER_AGENTS_EXECUTION_MODE` env, else `inline`. */
  executionMode?: ExecutionMode;
  cancelStore?: CancelStore;
  delegation?: Partial<DelegationLimits>;
  hooks?: Hook[];
  contextManager?: ContextManager;
  /** Pre-resolved tool sources, keyed by source id. When provided (e.g. from the loader), agents can mount tools at run time. */
  toolSources?: Map<string, import("@render-agents/engine").ToolSource>;
  /** Per-provider OAuth token refreshers (token-endpoint exchange). */
  oauthRefreshers?: Map<string, OAuthRefresher>;
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

function buildRunnerRegistry(
  model: ModelClient,
  pricing?: Record<string, ModelPricing>,
  extra?: Map<string, AgentRunner>,
): RunnerRegistry {
  const defaultRunner = new DefaultRunner(model, { pricing });
  return {
    get(name: string): AgentRunner {
      if (name === "default") return defaultRunner;
      const custom = extra?.get(name);
      if (custom) return custom;
      throw new Error(`Runner "${name}" not found`);
    },
    has: (name: string) => name === "default" || !!extra?.has(name),
  };
}

/**
 * Detect whether a Render Workflows dispatcher should be used. Returns a
 * dispatcher for production, undefined for local dev/test.
 *
 * Two distinct Render signals select it (sprint 01-Q, open question #2):
 * - `isWorkflowsEnvironment()` — an in-container socket for child `agent.task()`
 *   chaining (`runTask`).
 * - `isRootTriggerEnvironment()` — the REST client config (`RENDER_API_KEY` +
 *   `RENDER_WORKFLOW_SLUG`) used by the gateway to *trigger roots* (`startTask`),
 *   even though the gateway is not itself a Workflows container.
 * Either one means "drive the workflow lane through Render, not in-process".
 */
function detectDispatcher(): TaskDispatcher | undefined {
  if (!isWorkflowsEnvironment() && !isRootTriggerEnvironment()) return undefined;
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
  const runners = opts?.runners ?? buildRunnerRegistry(model, opts?.pricing, opts?.extraRunners);
  const cancelStore = opts?.cancelStore ?? new MemoryCancelStore();
  // Durable control-plane queue: shares the run store's pool in Postgres mode,
  // in-memory otherwise. Consumed by the runner (Phase 2) and gateway enqueue.
  const jobQueue = opts?.jobQueue ?? createJobQueue({ store });
  const executionMode: ExecutionMode =
    opts?.executionMode ?? (process.env.RENDER_AGENTS_EXECUTION_MODE === "queue" ? "queue" : "inline");
  const agentDefinitions = new Map<string, AgentDefinition>();
  // Populated later by bindWorkflow/loadWorkflows; the in-process root dispatcher
  // closes over this reference so a workflow registered after createRuntime is
  // still resolvable at dispatchRoot time.
  const workflows = new Map<string, WorkflowDefinition>();
  const toolSources = opts?.toolSources ?? new Map();
  // Shared instances so the dispatcher and any later registrations (e.g. the
  // gateway populating refreshers from provider configs) see the same objects.
  const oauthStore = asOAuthStore(store);
  const oauthRefreshers = opts?.oauthRefreshers ?? new Map<string, OAuthRefresher>();

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
      getWorkflow: (name) => workflows.get(name),
      oauthStore,
      oauthRefreshers,
    });

  // Inject hook interceptor into the store's append pipeline
  if (hooks.ids().length > 0 && "setInterceptor" in store) {
    const consoleLogger = { debug: () => {}, info: () => {}, warn: console.warn, error: console.error };
    const interceptor = buildHookInterceptor(hooks, consoleLogger, (name) => process.env[name]);
    (store as { setInterceptor: (i: unknown) => void }).setInterceptor(interceptor);
  }

  return {
    store,
    threadStore: asThreadStore(store),
    oauthStore,
    scheduleStore: asScheduleStore(store),
    oauthRefreshers,
    tracer,
    model,
    runners,
    hooks,
    contextManager,
    dispatcher,
    jobQueue,
    executionMode,
    cancelStore,
    agentDefinitions,
    workflows,
    delegation: opts?.delegation,
    toolSources,
  };
}

/**
 * Use the run store as the thread store when it implements the ThreadStore
 * surface (the bundled memory + Postgres stores do). Falls back to an in-memory
 * no-op for hand-rolled stores so the runtime field is always present.
 */
function asThreadStore(store: RunStore): ThreadStore {
  const candidate = store as Partial<ThreadStore>;
  if (typeof candidate.createThread === "function") return store as unknown as ThreadStore;
  const threads = new Map<string, Thread>();
  return {
    async createThread(thread: Thread) { threads.set(thread.id, { ...thread }); },
    async getThread(id: string) { const t = threads.get(id); return t ? { ...t } : undefined; },
    async updateThread(id: string, patch: Partial<Thread>) {
      const t = threads.get(id);
      if (t) threads.set(id, { ...t, ...patch, updatedAt: new Date().toISOString() });
    },
    async listThreads(o?: { userId?: string }) {
      return [...threads.values()].filter(t => !o?.userId || t.userId === o.userId).map(t => ({ ...t }));
    },
    async getThreadMessages(_threadId: string): Promise<ThreadMessage[]> { return []; },
  };
}

/**
 * Use the run store as the schedule store when it implements that surface (the
 * bundled memory + Postgres stores do). Falls back to an in-memory map for
 * hand-rolled stores so the runtime field is always present.
 */
function asScheduleStore(store: RunStore): ScheduleStore {
  const candidate = store as Partial<ScheduleStore>;
  if (typeof candidate.createSchedule === "function") return store as unknown as ScheduleStore;
  const schedules = new Map<string, ScheduleRecord>();
  return {
    async createSchedule(s: ScheduleRecord) { schedules.set(s.id, { ...s }); },
    async getSchedule(id: string) { const s = schedules.get(id); return s ? { ...s } : undefined; },
    async updateSchedule(id: string, patch: Partial<ScheduleRecord>) {
      const s = schedules.get(id);
      if (s) schedules.set(id, { ...s, ...patch, id: s.id, createdAt: s.createdAt, updatedAt: new Date().toISOString() });
    },
    async deleteSchedule(id: string) { schedules.delete(id); },
    async listSchedules() { return [...schedules.values()].map(s => ({ ...s })); },
    async listEnabled() { return [...schedules.values()].filter(s => s.enabled).map(s => ({ ...s })); },
  };
}

/**
 * Use the run store as the OAuth store when it implements that surface (the
 * bundled stores do). Falls back to an in-memory store for hand-rolled stores.
 */
function asOAuthStore(store: RunStore): OAuthStore {
  const candidate = store as Partial<OAuthStore>;
  if (typeof candidate.getConnection === "function") return store as unknown as OAuthStore;
  const conns = new Map<string, import("@render-agents/store").OAuthConnection>();
  const k = (u: string, p: string) => `${u}:${p}`;
  return {
    async getConnection(u, p) { const c = conns.get(k(u, p)); return c ? { ...c } : undefined; },
    async upsertConnection(c) { conns.set(k(c.userId, c.provider), { ...c }); },
    async deleteConnection(u, p) { conns.delete(k(u, p)); },
    async listConnections(u) { return [...conns.values()].filter(c => c.userId === u); },
    async refreshConnection(u, p, isExpired, doRefresh) {
      const c = conns.get(k(u, p));
      if (!c) return undefined;
      if (!isExpired(c)) return { ...c };
      const t = await doRefresh(c);
      const updated = { ...c, accessToken: t.accessToken, refreshToken: t.refreshToken ?? c.refreshToken, expiresAt: t.expiresAt, updatedAt: new Date().toISOString() };
      conns.set(k(u, p), updated);
      return { ...updated };
    },
  };
}
