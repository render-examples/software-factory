import type { ContentBlock, ToolResult } from "@render-agents/store";
import type { AgentDefinition, AgentInput, AgentOutput, Budget } from "./agent.js";
import { RunPaused } from "./agent.js";
import type { AgentRunner } from "./context.js";
import type { RunContext } from "./context.js";
import type { MountedTools, ToolContext } from "./tool.js";
import type { ModelClient, ModelPricing, ToolSchema } from "./model.js";
import { estimateCost } from "./model.js";

type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

interface ResolvedBudget {
  maxIterations: number;
  maxTokens: number;
  maxCostUsd: number | null;
}

export interface DefaultRunnerOptions {
  /** Custom/unlisted model pricing, merged over the built-in table for cost estimation. */
  pricing?: Record<string, ModelPricing>;
}

/**
 * The default agent loop (D9): iterate → call model → dispatch tools, with every
 * persisting step expressed as `ctx.emit`. The body stays small and pushes
 * behavior into `RunContext`/store so later sprints extend it without rewriting
 * the loop. Wave 0 covers real iterate/call/dispatch + event emission; deep
 * budget/structured-output/skills/compaction/HITL pause arrive in Wave 1+.
 */
export class DefaultRunner implements AgentRunner {
  constructor(
    private readonly model: ModelClient,
    private readonly options: DefaultRunnerOptions = {},
  ) {}

  async run(agent: AgentDefinition, input: AgentInput, ctx: RunContext): Promise<AgentOutput> {
    const mounted = await ctx.mountTools(agent.tools);
    const toolSchemas: ToolSchema[] = mounted.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    const budget = resolveBudget(agent.budget);
    const usage = { inputTokens: 0, outputTokens: 0 };

    await ctx.emit({ type: "run.started", input });
    await ctx.emit({ type: "message.user", content: inputToContent(input) });

    let iterations = 0;
    let tokensUsed = 0;
    let costUsed = 0;

    try {
      while (true) {
        if (await ctx.isCancelled()) {
          await ctx.emit({ type: "run.cancelled" });
          return { text: "", usage };
        }
        if (ctx.signal.aborted) throw new Error("run aborted");

        iterations += 1;
        if (iterations > budget.maxIterations) throw new Error("maxIterations reached");
        if (tokensUsed > budget.maxTokens) throw new Error("token budget exhausted");
        if (budget.maxCostUsd !== null && costUsed > budget.maxCostUsd) {
          throw new Error("cost budget exhausted");
        }

        const history = await ctx.messages(agent.name);
        const startedAt = Date.now();
        const result = await this.model.complete({
          model: agent.model,
          system: agent.systemPrompt,
          tools: toolSchemas,
          messages: history,
          sampling: agent.sampling,
          signal: ctx.signal,
        });
        const latencyMs = Date.now() - startedAt;
        const callCost = estimateCost(agent.model.model, result.usage, this.options.pricing);
        tokensUsed += result.usage.inputTokens + result.usage.outputTokens;
        costUsed += callCost;
        usage.inputTokens += result.usage.inputTokens;
        usage.outputTokens += result.usage.outputTokens;

        await ctx.emit({
          type: "llm.call",
          model: agent.model.model,
          usage: result.usage,
          costUsd: callCost,
          stopReason: result.stopReason,
          latencyMs,
        });
        await ctx.emit({ type: "message.assistant", agentName: agent.name, content: result.content });

        const toolUses = result.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (result.stopReason === "end_turn" || toolUses.length === 0) {
          const text = extractText(result.content);
          await ctx.emit({ type: "run.completed", result: text });
          return { text, usage };
        }

        const toolResultBlocks: ContentBlock[] = [];
        for (const toolUse of toolUses) {
          toolResultBlocks.push(await this.dispatchTool(agent, toolUse, mounted, ctx));
        }
        await ctx.emit({ type: "message.tool", agentName: agent.name, content: toolResultBlocks });
      }
    } catch (err) {
      if (err instanceof RunPaused) throw err;
      await ctx.emit({ type: "run.failed", error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private async dispatchTool(
    agent: AgentDefinition,
    toolUse: ToolUseBlock,
    mounted: MountedTools,
    ctx: RunContext,
  ): Promise<ContentBlock> {
    const { id: toolCallId, name } = toolUse;

    // 1. Idempotency: a canonical terminal result short-circuits re-execution.
    const applied = await ctx.appliedToolResult(toolCallId);
    if (applied) return toolResultBlock(toolCallId, applied);

    // 2. Approval gate.
    if (agent.permissions?.requireApproval?.includes(name)) {
      const approval = await ctx.requestApproval(name, toolUse.input);
      if ("status" in approval) {
        throw new RunPaused(ctx.runId, "approval", [approval.approvalRequestId]);
      }
      if (approval.approved === false) {
        const denied: ToolResult = {
          content: `Tool call denied${approval.reason ? `: ${approval.reason}` : ""}`,
          isError: true,
        };
        // Canonical error result; no `tool.called` is emitted for a denied call.
        await ctx.emit({ type: "tool.result", toolCallId, name, result: denied });
        return toolResultBlock(toolCallId, denied);
      }
    }

    // 3. Lookup. An unknown tool (model hallucination) is a recoverable error.
    const tool = mounted.byName(name);
    if (!tool) {
      const err: ToolResult = { content: `Unknown tool: ${name}`, isError: true };
      return toolResultBlock(toolCallId, err);
    }

    // 4. Deep input validation against inputSchema: Sprint 07/08.
    // 5. Dispatch.
    await ctx.emit({ type: "tool.called", toolCallId, name, input: toolUse.input });
    let result: ToolResult;
    try {
      result = await tool.invoke(toolUse.input, toolContextFrom(ctx));
    } catch (err) {
      result = { content: err instanceof Error ? err.message : String(err), isError: true };
    }
    // 6. Record.
    await ctx.emit({ type: "tool.result", toolCallId, name, result });
    return toolResultBlock(toolCallId, result);
  }
}

function resolveBudget(budget?: Budget): ResolvedBudget {
  const rawCost = budget?.maxCostUsd === undefined ? 10 : budget.maxCostUsd;
  // null or 0 deliberately disables the cost ceiling.
  const maxCostUsd = rawCost === null || rawCost === 0 ? null : rawCost;
  return {
    maxIterations: budget?.maxIterations ?? 50,
    maxTokens: budget?.maxTokens ?? 1_000_000,
    maxCostUsd,
  };
}

function inputToContent(input: AgentInput): ContentBlock[] {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return [{ type: "text", text }];
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toolResultBlock(toolCallId: string, result: ToolResult): ContentBlock {
  return { type: "tool_result", toolUseId: toolCallId, content: result.content, isError: result.isError };
}

function toolContextFrom(ctx: RunContext): ToolContext {
  return {
    env: (name) => ctx.env(name),
    signal: ctx.signal,
    logger: ctx.logger,
    connection: async () => undefined,
    fetch: (url, init) => fetch(url, init),
  };
}
