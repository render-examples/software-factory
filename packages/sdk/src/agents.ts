import { randomUUID } from "node:crypto";
import type {
  AgentDefinition,
  AgentInput,
  AgentOutput,
  AgentResult,
  RunOptions,
  TaskOptions,
} from "@render-factory/engine";
import { RunPaused } from "@render-factory/engine";
import { idempotencyKey } from "@render-factory/store";
import type { AgentRuntime } from "./runtime.js";
import { runAgentInProcess } from "./run-in-process.js";
import { loadAgentsFromDir } from "./loader/load-agents.js";

export interface AgentSet {
  get(id: string): Agent;
  get(ids: string[]): Agent[];
  has(id: string): boolean;
  all(): Agent[];
}

export interface Agent {
  readonly name: string;
  readonly definition: AgentDefinition;

  /**
   * Run the agent in-process within the current workflow.
   *
   * Use for sequential pipeline steps where the next step depends on this
   * result. Faster than task() (no dispatch overhead), but shares the workflow
   * process — if it crashes, the workflow restarts from its last memoized step.
   *
   * Both run() and task() are replay-safe: deterministic child run IDs ensure
   * re-drives return the memoized result instead of re-running the agent.
   */
  run<T = unknown>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>>;

  /**
   * Dispatch the agent as a durable isolated task on Render Workflows.
   *
   * Use when:
   * - Multiple agents should run in parallel: `Promise.all([a.task(), b.task()])`
   * - The agent needs a different compute plan than the workflow host
   * - You want the agent's work to survive independently of the parent process
   *
   * Both run() and task() are replay-safe: deterministic child run IDs ensure
   * re-drives return the memoized result instead of re-dispatching.
   */
  task<T = unknown>(input: AgentInput, opts?: TaskOptions): Promise<AgentOutput<T>>;
}

export async function loadAgents(dir: string, runtime: AgentRuntime): Promise<AgentSet> {
  const inert = await loadAgentsFromDir(dir);
  const definitions = inert.all().map((a) => a.definition);
  return bindAgentSet(definitions, runtime);
}

function bindAgentSet(definitions: AgentDefinition[], runtime: AgentRuntime): AgentSet {
  const byName = new Map<string, AgentDefinition>();
  for (const def of definitions) byName.set(def.name, def);

  // Publish the loaded definitions to the runtime so the dispatcher and
  // subagent delegation can resolve agents by name.
  for (const def of definitions) runtime.agentDefinitions.set(def.name, def);

  const getOne = (id: string): Agent => {
    const def = byName.get(id);
    if (!def) throw new Error(`Agent "${id}" not found`);
    return bindAgent(def, runtime);
  };

  function get(id: string): Agent;
  function get(ids: string[]): Agent[];
  function get(id: string | string[]): Agent | Agent[] {
    return Array.isArray(id) ? id.map(getOne) : getOne(id);
  }

  return {
    get,
    has: (id: string) => byName.has(id),
    all: () => [...byName.values()].map((def) => bindAgent(def, runtime)),
  };
}

function bindAgent(definition: AgentDefinition, runtime: AgentRuntime): Agent {
  // Ensure the definition is resolvable for subagent/dispatch lookups even when
  // an agent is constructed directly (not via loadAgents).
  if (!runtime.agentDefinitions.has(definition.name)) {
    runtime.agentDefinitions.set(definition.name, definition);
  }
  return {
    name: definition.name,
    definition,
    run<T>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>> {
      return runInProcess<T>(definition, input, runtime, opts);
    },
    task<T>(input: AgentInput, opts?: TaskOptions): Promise<AgentOutput<T>> {
      const runId = opts?.runId ?? randomUUID();
      return runtime.dispatcher.dispatch(definition.name, input, {
        runId,
        parentSpanId: opts?.parentSpanId,
        idempotencyKey: idempotencyKey(runId, `${definition.name}:0`),
        plan: definition.plan,
        signal: opts?.signal,
      }) as Promise<AgentOutput<T>>;
    },
  };
}

/**
 * Resume a paused agent run (HITL pause → out-of-band approval/input → resume).
 *
 * The pause is recorded in the event log (`run.paused`) and the resolution
 * (`input.provided` / a new `message.user`) is appended out-of-band by the
 * gateway. Resuming re-invokes the agent loop with the **same** runId: the
 * runner's `hasStarted()` guard skips the opening events and its
 * pending-tool-use replay dispatches the now-unblocked tool calls, driving the
 * run to completion (or the next pause). Idempotent — resolved approvals and
 * already-applied tool results short-circuit on replay.
 *
 * In production the workflow service owns durable resume; this in-process driver
 * provides identical observable behavior for local dev and the gateway.
 */
export async function resumeRun<T = unknown>(
  runId: string,
  runtime: AgentRuntime,
  opts?: { signal?: AbortSignal },
): Promise<AgentResult<T>> {
  const run = await runtime.store.getRun(runId);
  if (!run) throw new Error(`resumeRun: run "${runId}" not found`);
  if (run.status !== "paused") {
    if (run.status === "completed") {
      return { status: "completed", text: "", data: run.result as T, usage: { inputTokens: 0, outputTokens: 0 } };
    }
    throw new Error(`resumeRun: run "${runId}" is not resumable (status: ${run.status})`);
  }

  // Agent name is the run's workflow label. HITL pauses happen inside agent
  // runs; a paused workflow-root would fail here with a clear error.
  const agentName = run.workflow;
  const definition = runtime.agentDefinitions.get(agentName);
  if (!definition) {
    throw new Error(
      `resumeRun: no agent named "${agentName}" for run "${runId}" in the runtime ` +
      `(only agent runs are resumable). Ensure agents are loaded via loadAgents() before resuming.`,
    );
  }

  // Recover the original input from the log (the runner ignores it on resume,
  // but pass it for correctness/fidelity).
  const events = await runtime.store.events.read(runId);
  const started = events.find((e) => e.payload.type === "run.started");
  const input: AgentInput =
    started?.payload.type === "run.started" ? ((started.payload.input as AgentInput) ?? "") : "";

  try {
    // A chat-agent resume continues a turn within a thread: keep thread-scoped
    // memory so the resumed turn still sees prior turns. Non-chat resume stays
    // run-scoped (unchanged).
    const output = await runInProcess<T>(definition, input, runtime, {
      runId,
      signal: opts?.signal,
      threadId: run.threadId,
      threadScopedHistory: !!run.threadId && !!definition.interactive,
    });
    return { status: "completed", ...output };
  } catch (err) {
    if (err instanceof RunPaused) {
      return { status: "paused", reason: err.reason, pendingInputIds: err.pendingInputIds };
    }
    throw err;
  }
}

/** Internal run options: public `RunOptions` plus chat-lane history scoping. */
interface InternalRunOptions extends RunOptions {
  threadId?: string;
  threadScopedHistory?: boolean;
}

/**
 * Drive a single chat-lane agent turn in-process (Lane B, warm worker). The
 * gateway has already recorded the opening turn (`run.started` + `message.user`)
 * before enqueue, so the runner's `hasStarted()` guard skips re-emitting them.
 * History is thread-scoped (multi-turn memory) and `agent.task()` children still
 * go through `runtime.dispatcher` (offloaded to Render when present). Throws
 * `RunPaused` if HITL within the turn parks it — the caller settles the job.
 */
export async function driveAgentTurn(
  runtime: AgentRuntime,
  runId: string,
  opts?: { signal?: AbortSignal },
): Promise<AgentOutput> {
  const run = await runtime.store.getRun(runId);
  if (!run) throw new Error(`driveAgentTurn: run "${runId}" not found`);
  const agentName = run.workflow;
  const definition = runtime.agentDefinitions.get(agentName);
  if (!definition) {
    throw new Error(
      `driveAgentTurn: no agent named "${agentName}" for run "${runId}" in the runtime. ` +
      `Ensure agents are loaded via loadAgents() before driving chat turns.`,
    );
  }
  return runInProcess(definition, (run.input as AgentInput) ?? "", runtime, {
    runId,
    threadId: run.threadId,
    threadScopedHistory: true,
    signal: opts?.signal,
  });
}

function runInProcess<T>(
  definition: AgentDefinition,
  input: AgentInput,
  runtime: AgentRuntime,
  opts?: InternalRunOptions,
): Promise<AgentOutput<T>> {
  return runAgentInProcess<T>(definition, input, {
    store: runtime.store,
    tracer: runtime.tracer,
    runners: runtime.runners,
    contextManager: runtime.contextManager,
    cancelStore: runtime.cancelStore,
    toolSources: runtime.toolSources,
    getDefinition: (name) => runtime.agentDefinitions.get(name),
    childDispatcher: runtime.dispatcher ?? createInlineDispatcher(runtime),
    delegation: runtime.delegation,
    oauthStore: runtime.oauthStore,
    oauthRefreshers: runtime.oauthRefreshers,
    deltaBus: runtime.deltaBus,
    suspender: runtime.suspender,
  }, {
    runId: opts?.runId,
    parentSpanId: opts?.parentSpanId,
    threadId: opts?.threadId,
    threadScopedHistory: opts?.threadScopedHistory,
    signal: opts?.signal,
    approvedToolCallIds: opts?.approvedToolCallIds,
  });
}

/**
 * Fallback dispatcher for subagent children when a runtime somehow has no
 * dispatcher configured. createRuntime always installs one, so this is only a
 * safety net for hand-assembled runtimes.
 */
function createInlineDispatcher(runtime: AgentRuntime) {
  return {
    dispatch: (name: string, input: AgentInput, dOpts: { runId: string; parentSpanId?: string; userId?: string; depth?: number; signal?: AbortSignal }) => {
      const def = runtime.agentDefinitions.get(name);
      if (!def) throw new Error(`Agent "${name}" not found in the runtime`);
      return runAgentInProcess(def, input, {
        store: runtime.store,
        tracer: runtime.tracer,
        runners: runtime.runners,
        contextManager: runtime.contextManager,
        cancelStore: runtime.cancelStore,
        toolSources: runtime.toolSources,
        getDefinition: (n) => runtime.agentDefinitions.get(n),
        childDispatcher: createInlineDispatcher(runtime),
        delegation: runtime.delegation,
        oauthStore: runtime.oauthStore,
        oauthRefreshers: runtime.oauthRefreshers,
        deltaBus: runtime.deltaBus,
        suspender: runtime.suspender,
      }, { runId: dOpts.runId, parentSpanId: dOpts.parentSpanId, userId: dOpts.userId, depth: dOpts.depth, signal: dOpts.signal });
    },
  };
}
