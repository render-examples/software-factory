/**
 * AgentRunner — pluggable agent execution loop.
 * Pure interfaces. Runner implementations live in sdk/runners/.
 */
import type { ResolvedTool } from "./tools.js";

export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: "tool_result";
      readonly id: string;
      readonly name: string;
      readonly content: string;
      readonly isError: boolean;
    }
  | { readonly type: "result"; readonly result: string }
  | { readonly type: "error"; readonly error: Error };

export interface RunContext {
  readonly agentId: string;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly tools: readonly ResolvedTool[];
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
}

export interface AgentRunner {
  run(ctx: RunContext): AsyncIterable<AgentEvent>;
}
