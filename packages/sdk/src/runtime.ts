import type {
  RunStore,
  Tracer,
  CancelStore,
  ThreadStore,
  Thread,
  ThreadMessage,
  ThreadSurfaceStore,
  ThreadSurface,
  ThreadItemStore,
  ThreadItem,
  AppendItemInput,
  OAuthStore,
  ScheduleStore,
  ScheduleRecord,
} from "@render-factory/store";
import type { JobQueue, DeltaBus } from "@render-factory/store";
import { createStore, createJobQueue, createDeltaBus, createCancelStore } from "@render-factory/store";
import type {
  ModelClient,
  AgentRunner,
  AgentDefinition,
  Hook,
  HookRegistry,
  ContextManager,
  DelegationLimits,
  AgentInput,
  AgentOutput,
  RenderPlan,
  ModelPricing,
  OAuthRefresher,
  Suspender,
  SandboxProvider,
} from "@render-factory/engine";
import { DefaultRunner, DefaultContextManager, noopTracer, buildHookInterceptor, createSandboxToolSource } from "@render-factory/engine";
import { RenderWorkflowsDispatcher, InProcessDispatcher, isWorkflowsEnvironment, isRootTriggerEnvironment } from "./dispatch.js";
import type { WorkflowDefinition } from "./workflow.js";
import type { Channel } from "./channel.js";

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
  /**
   * Cancel scope (the root run id) this child belongs to (E3). Cancelling the
   * root cascades to descendants that share the scope. Propagated to the child's
   * run context and onward to its own children.
   */
  cancelScopeId?: string;
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
  /** Workflow-specific input payload (forwarded to the task handler). */
  input?: Record<string, unknown>;
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
  /**
   * Whether this dispatcher's runtime supports native durable suspension (Lane A
   * on Render Workflows) rather than resume-by-replay. When true, the gateway
   * wakes a parked run by delivering the resolution via `resumeSuspension`
   * instead of re-triggering + replaying it. Defaults to falsy (replay).
   */
  supportsNativeSuspension?: boolean;
  /**
   * Wake a natively-suspended run — a workflow root *or* a child `agent.task()`
   * whose gate parked — by triggering its resume webhook/endpoint (keyed by
   * `token`) so the parked `await` returns and reads the recorded resolution
   * from the event log. Present only when `supportsNativeSuspension` is true;
   * otherwise resume is a re-drive (`dispatchRoot`) that replays from the log.
   */
  resumeSuspension?(job: { runId: string; token: string; payload?: unknown }): Promise<void>;
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
/** @deprecated No longer used — all agent execution goes through Render Workflows or inline fallback. */
export type ExecutionMode = "inline" | "queue";

export interface AgentRuntime {
  readonly store: RunStore;
  /** Thread metadata + transcript store. Defaults to the run store when it implements ThreadStore. */
  readonly threadStore: ThreadStore;
  /** Thread surface bindings (channel + address per thread). Defaults to the run store when it implements ThreadSurfaceStore. */
  readonly surfaceStore: ThreadSurfaceStore;
  /** Thread-level item log (user messages, results, errors). Defaults to the run store when it implements ThreadItemStore. */
  readonly itemStore: ThreadItemStore;
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
  readonly dispatcher: TaskDispatcher;
  /**
   * HITL suspension strategy (the `Suspender` seam), threaded into in-process
   * runs. Undefined = default resume-by-replay (`ReplaySuspender`). A
   * `NativeWorkflowsSuspender` can be injected for Lane A native durable
   * pause/resume once the platform API is available.
   */
  readonly suspender?: Suspender;
  /** Durable job queue (control plane) for root-run + resume dispatch. Backed by Postgres when available, else in-memory. */
  readonly jobQueue: JobQueue;
  /** Transient token-delta bus (D13) for live streaming; never persisted. Postgres NOTIFY when available, else in-memory. */
  readonly deltaBus: DeltaBus;
  /** @deprecated Retained for backward compat; always returns "inline". */
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
  readonly toolSources: Map<string, import("@render-factory/engine").ToolSource>;
  /**
   * Discovered channels keyed by id. Populated by `loadProject`; used by the
   * gateway's channel routes (inbound) and the outbound delivery path
   * (`notifyThreadSurfaces`).
   */
  readonly channels: Map<string, Channel>;
}

export interface CreateRuntimeOptions {
  /** Required. Scopes all data access to this tenant. */
  tenantId: string;
  store?: RunStore;
  tracer?: Tracer;
  /** Required. The LLM client used by the default runner. No auto-detection. */
  model: ModelClient;
  pricing?: Record<string, ModelPricing>;
  runners?: RunnerRegistry;
  /** Custom runners discovered from `runners/` (keyed by name); merged with the built-in `default`. */
  extraRunners?: Map<string, AgentRunner>;
  dispatcher?: TaskDispatcher;
  /**
   * Auto-detect a Render Workflows dispatcher from the ambient environment
   * (`RENDER_USE_LOCAL_DEV` / `RENDER_SDK_SOCKET_PATH` / `RENDER_WORKFLOW_SLUG`).
   * Defaults to `true`. Set `false` to force the in-process dispatcher regardless
   * of ambient env — tests use this so they stay hermetic when run inside a
   * `render workflows dev` shell (where those vars are exported).
   */
  autoDetectDispatcher?: boolean;
  /** Override the HITL suspension strategy (default: resume-by-replay). */
  suspender?: Suspender;
  jobQueue?: JobQueue;
  deltaBus?: DeltaBus;
  /** @deprecated Ignored. Execution always dispatches to Render Workflows (or inline fallback). */
  executionMode?: ExecutionMode;
  cancelStore?: CancelStore;
  delegation?: Partial<DelegationLimits>;
  hooks?: Hook[];
  contextManager?: ContextManager;
  /** Pre-resolved tool sources, keyed by source id. When provided (e.g. from the loader), agents can mount tools at run time. */
  toolSources?: Map<string, import("@render-factory/engine").ToolSource>;
  /** Per-provider OAuth token refreshers (token-endpoint exchange). */
  oauthRefreshers?: Map<string, OAuthRefresher>;
  /** Discovered channels (keyed by id); usually populated by `loadProject`. */
  channels?: Map<string, Channel>;
  surfaceStore?: ThreadSurfaceStore;
  itemStore?: ThreadItemStore;
  /**
   * Pluggable sandbox provider. When set, a "sandbox" tool source is
   * automatically registered that connects to sandboxes by ID. Agents
   * pass `sandbox_id` on every tool call to target a specific sandbox.
   */
  sandbox?: SandboxProvider;
}


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
 * Detect whether a Render Workflows dispatcher should be used (production) vs
 * undefined (local dev/test). Either signal means "drive through Render":
 * - `isWorkflowsEnvironment()` — in-container socket for child `agent.task()`.
 * - `isRootTriggerEnvironment()` — REST client config for the gateway to
 *   trigger roots (`startTask`) without itself being a Workflows container.
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
export async function createRuntime(opts: CreateRuntimeOptions): Promise<AgentRuntime> {
  if (!opts.tenantId) throw new Error("createRuntime requires a tenantId");
  const { tenantId } = opts;

  const store: RunStore = opts.store ?? createStore({ tenantId });
  await store.init();

  const tracer = opts.tracer ?? noopTracer;
  const model = opts.model;
  const contextManager = opts.contextManager ?? new DefaultContextManager({ model });
  const hooks = buildHookRegistry(opts.hooks ?? []);
  const runners = opts.runners ?? buildRunnerRegistry(model, opts.pricing, opts.extraRunners);
  const cancelStore = opts.cancelStore ?? createCancelStore({ store, tenantId });
  const jobQueue = opts.jobQueue ?? createJobQueue({ store, tenantId });
  const deltaBus = opts.deltaBus ?? createDeltaBus({ store });
  const executionMode: ExecutionMode = "inline";
  const agentDefinitions = new Map<string, AgentDefinition>();
  const workflows = new Map<string, WorkflowDefinition>();
  const toolSources = opts.toolSources ?? new Map();

  if (opts.sandbox && !toolSources.has("sandbox")) {
    toolSources.set("sandbox", createSandboxToolSource({
      provider: opts.sandbox,
    }));
  }

  const channels = opts.channels ?? new Map<string, Channel>();
  const oauthStore = asOAuthStore(store);
  const oauthRefreshers = opts.oauthRefreshers ?? new Map<string, OAuthRefresher>();

  const dispatcher = opts.dispatcher
    ?? (opts.autoDetectDispatcher === false ? undefined : detectDispatcher())
    ?? new InProcessDispatcher({
      store,
      runners,
      model,
      contextManager,
      cancelStore,
      toolSources,
      delegation: opts.delegation,
      getDefinition: (name) => agentDefinitions.get(name),
      getWorkflow: (name) => workflows.get(name),
      oauthStore,
      oauthRefreshers,
      deltaBus,
      suspender: opts?.suspender,
    });

  if (hooks.ids().length > 0 && "setInterceptor" in store) {
    const consoleLogger = { debug: () => {}, info: () => {}, warn: console.warn, error: console.error };
    const interceptor = buildHookInterceptor(hooks, consoleLogger, (name) => process.env[name]);
    (store as { setInterceptor: (i: unknown) => void }).setInterceptor(interceptor);
  }

  return {
    store,
    threadStore: asThreadStore(store),
    surfaceStore: opts.surfaceStore ?? asSurfaceStore(store),
    itemStore: opts.itemStore ?? asItemStore(store),
    oauthStore,
    scheduleStore: asScheduleStore(store),
    oauthRefreshers,
    tracer,
    model,
    runners,
    hooks,
    contextManager,
    dispatcher,
    suspender: opts?.suspender,
    jobQueue,
    deltaBus,
    executionMode,
    cancelStore,
    agentDefinitions,
    workflows,
    delegation: opts?.delegation,
    toolSources,
    channels,
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
 * Use the run store as the surface store when it implements that surface (the
 * bundled Postgres store does). Falls back to an in-memory store.
 */
function asSurfaceStore(store: RunStore): ThreadSurfaceStore {
  const candidate = store as Partial<ThreadSurfaceStore>;
  if (typeof candidate.upsertSurface === "function") return store as unknown as ThreadSurfaceStore;
  const surfaces = new Map<string, ThreadSurface[]>();
  let nextId = 0;
  return {
    async upsertSurface(threadId: string, channel: string, address: string): Promise<ThreadSurface> {
      const list = surfaces.get(threadId) ?? [];
      const existing = list.find((s) => s.channel === channel && s.address === address);
      if (existing) return { ...existing };
      const surface: ThreadSurface = { id: String(++nextId), threadId, channel, address, createdAt: new Date().toISOString() };
      list.push(surface);
      surfaces.set(threadId, list);
      return { ...surface };
    },
    async getSurfaces(threadId: string): Promise<ThreadSurface[]> {
      return (surfaces.get(threadId) ?? []).map((s) => ({ ...s }));
    },
    async removeSurface(id: string): Promise<void> {
      for (const [tid, list] of surfaces) {
        const idx = list.findIndex((s) => s.id === id);
        if (idx >= 0) { list.splice(idx, 1); if (list.length === 0) surfaces.delete(tid); return; }
      }
    },
  };
}

/**
 * Use the run store as the item store when it implements that surface (the
 * bundled Postgres store does). Falls back to an in-memory store.
 */
function asItemStore(store: RunStore): ThreadItemStore {
  const candidate = store as Partial<ThreadItemStore>;
  if (typeof candidate.appendItem === "function") return store as unknown as ThreadItemStore;
  const items = new Map<string, ThreadItem[]>();
  return {
    async appendItem(input: AppendItemInput): Promise<ThreadItem> {
      const list = items.get(input.threadId) ?? [];
      const item: ThreadItem = {
        id: String(list.length + 1),
        threadId: input.threadId,
        runId: input.runId,
        seq: list.length + 1,
        kind: input.kind,
        role: input.role,
        content: input.content,
        data: input.data,
        createdAt: new Date().toISOString(),
      };
      list.push(item);
      items.set(input.threadId, list);
      return { ...item };
    },
    async getItems(threadId: string, opts?: { limit?: number; afterSeq?: number }): Promise<ThreadItem[]> {
      let list = items.get(threadId) ?? [];
      if (opts?.afterSeq != null) list = list.filter((i) => i.seq > opts.afterSeq!);
      if (opts?.limit != null) list = list.slice(0, opts.limit);
      return list.map((i) => ({ ...i }));
    },
  };
}

/**
 * Use the run store as the OAuth store when it implements that surface (the
 * bundled stores do). Falls back to an in-memory store for hand-rolled stores.
 */
function asOAuthStore(store: RunStore): OAuthStore {
  const candidate = store as Partial<OAuthStore>;
  if (typeof candidate.getConnection === "function") return store as unknown as OAuthStore;
  const conns = new Map<string, import("@render-factory/store").OAuthConnection>();
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
