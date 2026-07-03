import type { ToolResult, Logger } from "@render-agents/store";
import type { AgentDefinition, AgentOutput } from "./agent.js";
import { RunPaused } from "./agent.js";
import type { Tool, ToolSource, ResolvedSource, ToolContext } from "./tool.js";
import type { DelegationLimits } from "./delegation.js";

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_FANOUT = 50;

export interface SubagentDispatcher {
  dispatch(agentName: string, input: unknown, opts: {
    parentSpanId: string;
    userId?: string;
    depth: number;
    toolCallId: string;
  }): Promise<AgentOutput>;
}

export interface SubagentSourceOptions {
  dispatcher: SubagentDispatcher;
  limits?: Partial<DelegationLimits>;
  currentDepth: number;
  userId?: string;
  parentSpanId: string;
  logger: Logger;
  getFanoutCount: () => Promise<number>;
}

/**
 * Build `subagents__<name>` tool sources from an agent's declared subagents.
 * Each becomes a tool the model can call; invocation dispatches a child run
 * via agent.task() with proper depth/identity propagation.
 */
export function buildSubagentToolSource(
  subagentDefs: Array<{ name: string; description?: string; definition: AgentDefinition }>,
  opts: SubagentSourceOptions,
): ToolSource {
  const id = "subagents";
  const limits: DelegationLimits = {
    maxDepth: opts.limits?.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxFanout: opts.limits?.maxFanout ?? DEFAULT_MAX_FANOUT,
  };

  return {
    id,
    async resolve(): Promise<ResolvedSource> {
      const tools: Tool[] = subagentDefs.map((sub) => ({
        name: `subagents__${sub.name}`,
        description: sub.description ?? `Delegate work to the ${sub.name} agent.`,
        inputSchema: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "The task or question to delegate to this agent.",
            },
          },
          required: ["input"],
        },
        async invoke(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
          const input = typeof rawInput === "object" && rawInput !== null
            ? (rawInput as Record<string, unknown>).input ?? rawInput
            : rawInput;

          const childDepth = opts.currentDepth + 1;
          if (childDepth > limits.maxDepth) {
            return {
              content: `Delegation depth limit exceeded (max ${limits.maxDepth}). ` +
                `Cannot spawn subagent "${sub.name}" at depth ${childDepth}.`,
              isError: true,
            };
          }

          const currentFanout = await opts.getFanoutCount();
          if (currentFanout >= limits.maxFanout) {
            return {
              content: `Delegation fanout limit exceeded (max ${limits.maxFanout}). ` +
                `Cannot spawn additional subagents.`,
              isError: true,
            };
          }

          try {
            const result = await opts.dispatcher.dispatch(sub.name, input, {
              parentSpanId: opts.parentSpanId,
              userId: opts.userId,
              depth: childDepth,
              toolCallId: ctx.toolCallId ?? "",
            });

            if (result.data !== undefined) {
              return { content: JSON.stringify(result.data) };
            }
            return { content: result.text };
          } catch (err) {
            // A paused subagent must surface up so the parent run also pauses for
            // approval/input — never swallow it into a generic error result.
            if (err instanceof RunPaused) throw err;
            return {
              content: `Subagent "${sub.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
        },
      }));

      return { tools, close: async () => {} };
    },
  };
}
