/**
 * AgentRunner — pluggable agent execution loop.
 *
 * Pure interfaces only. No SDK imports. Each runner implementation
 * (e.g. ClaudeRunner, CodexRunner) lives in sdk/runners/.
 */
import type { ResolvedTool } from "./tools.js";

// ---------------------------------------------------------------------------
// AgentEvent — the event seam for hooks, eval, and observability
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// RunContext — everything the runner needs to execute an agent turn
// ---------------------------------------------------------------------------

export interface RunContext {
  readonly agentId: string;
  readonly prompt: string;
  readonly systemPrompt: string;
  /** All tools the agent declared, resolved by the registry. */
  readonly tools: readonly ResolvedTool[];
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// AgentRunner interface
// ---------------------------------------------------------------------------

export interface AgentRunner {
  run(ctx: RunContext): AsyncIterable<AgentEvent>;
}
