import { randomUUID } from "node:crypto";
import type {
  AgentDefinition,
  AgentInput,
  AgentOutput,
  RunOptions,
  TaskOptions,
} from "@render-agents/engine";
import { InProcessRunContext } from "@render-agents/engine";
import { idempotencyKey } from "@render-agents/store";
import type { AgentRuntime } from "./runtime.js";
import { createRuntime } from "./runtime.js";
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
  run<T = unknown>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>>;
  task<T = unknown>(input: AgentInput, opts?: TaskOptions): Promise<AgentOutput<T>>;
}

export async function loadAgents(dir?: string, runtime?: AgentRuntime): Promise<AgentSet> {
  // `dir` is the project root containing agents/, tools/, skills/ (see loader).
  const projectDir = dir ?? ".";
  const inert = await loadAgentsFromDir(projectDir);
  const definitions = inert.all().map((a) => a.definition);
  const rt = runtime ?? (await createRuntime());
  return bindAgentSet(definitions, rt);
}

function bindAgentSet(definitions: AgentDefinition[], runtime: AgentRuntime): AgentSet {
  const byName = new Map<string, AgentDefinition>();
  for (const def of definitions) byName.set(def.name, def);

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
  return {
    name: definition.name,
    definition,
    run<T>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>> {
      return runInProcess<T>(definition, input, runtime, opts);
    },
    task<T>(input: AgentInput, opts?: TaskOptions): Promise<AgentOutput<T>> {
      if (!runtime.dispatcher) {
        // Local-dev/testing parity: no workflow server → run in-process.
        return runInProcess<T>(definition, input, runtime, opts);
      }
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

function runInProcess<T>(
  definition: AgentDefinition,
  input: AgentInput,
  runtime: AgentRuntime,
  opts?: RunOptions,
): Promise<AgentOutput<T>> {
  const runId = opts?.runId ?? randomUUID();
  const runner = runtime.runners.get(definition.runner ?? "default");
  const ctx = new InProcessRunContext({
    runId,
    store: runtime.store,
    tracer: runtime.tracer,
    model: definition.model,
    agentName: definition.name,
    contextManager: runtime.contextManager,
    signal: opts?.signal ?? new AbortController().signal,
    parentSpanId: opts?.parentSpanId,
    maxContextTokens: definition.context?.maxContextTokens,
  });
  return runner.run(definition, input, ctx) as Promise<AgentOutput<T>>;
}
