import type {
  AgentDefinition,
  AgentInput,
  AgentOutput,
  RunOptions,
  TaskOptions,
} from "@render-agents/engine";
import type { AgentRuntime } from "./runtime.js";
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

export async function loadAgents(dir?: string, _runtime?: AgentRuntime): Promise<AgentSet> {
  const projectDir = dir ?? ".";
  return loadAgentsFromDir(projectDir);
}
