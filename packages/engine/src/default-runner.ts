import type { ContentBlock, ToolResult } from "@render-agents/store";
import type { AgentDefinition, AgentInput, AgentOutput, Budget, SkillMetadata } from "./agent.js";
import { RunPaused } from "./agent.js";
import type { AgentRunner } from "./context.js";
import type { RunContext } from "./context.js";
import type { MountedTools, Tool, ToolContext } from "./tool.js";
import type { ModelClient, ModelPricing, ToolSchema } from "./model.js";
import { estimateCost, addUsage } from "./model.js";
import { validateToolInput } from "./schema-validate.js";
import { ssrfFetch } from "./ssrf-fetch.js";

type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

interface ResolvedBudget {
  maxIterations: number;
  maxTokens: number;
  maxCostUsd: number | null;
  maxWallSeconds: number | null;
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
    // Declared tools plus, if the agent delegates, the `subagents__<name>`
    // delegation tools (resolved from the "subagents" source mounted by the
    // run context when subagents are present).
    const subagentToolIds = (agent.subagents ?? []).map((name) => `subagents__${name}`);
    const mounted = await ctx.mountTools([...agent.tools, ...subagentToolIds]);
    const skillTool = buildSkillTool(agent.skills);
    const allTools = skillTool ? [...mounted.tools, skillTool] : mounted.tools;
    const toolSchemas: ToolSchema[] = allTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    const allMounted: MountedTools = {
      tools: allTools,
      byName: (name: string) => allTools.find((t) => t.name === name),
    };

    const systemPrompt = buildSystemPrompt(agent.systemPrompt, agent.skills);
    const budget = resolveBudget(agent.budget);
    const usage = { inputTokens: 0, outputTokens: 0 };

    // Resume support (D7): a run already in the log is being re-executed; do not
    // re-emit its opening events (that would duplicate the user turn).
    if (!(await ctx.hasStarted())) {
      await ctx.emit({ type: "run.started", input, agentVersion: agent.version, model: agent.model.model });
      await ctx.emit({ type: "message.user", content: inputToContent(input) });
    }

    let iterations = 0;
    let tokensUsed = 0;
    let costUsed = 0;
    const runStartedAt = Date.now();

    try {
      while (true) {
        if (await ctx.isCancelled()) {
          await ctx.emit({ type: "run.cancelled" });
          return { text: "", usage };
        }
        if (ctx.signal.aborted) throw new Error("run aborted");

        iterations += 1;
        if (iterations > budget.maxIterations) throw new Error("maxIterations reached");

        if (budget.maxWallSeconds !== null) {
          const elapsed = (Date.now() - runStartedAt) / 1000;
          if (elapsed > budget.maxWallSeconds) throw new Error("wall-clock budget exhausted");
        }

        const history = await ctx.messages(agent.name);

        // Resume-by-replay: if the latest turn is an assistant message with
        // tool_use blocks that haven't been answered yet (the run paused here,
        // or this is a fresh continuation), dispatch those tools instead of
        // re-calling the model. Idempotency short-circuits already-applied
        // tools; a now-resolved approval lets the previously-paused tool run.
        const pending = pendingToolUses(history);
        if (pending.length > 0) {
          const toolResultBlocks: ContentBlock[] = [];
          for (const toolUse of pending) {
            toolResultBlocks.push(await this.dispatchTool(agent, toolUse, allMounted, ctx));
          }
          await ctx.emit({ type: "message.tool", agentName: agent.name, content: toolResultBlocks });
          continue;
        }

        const startedAt = Date.now();
        const result = await this.model.complete({
          model: agent.model,
          system: systemPrompt,
          tools: toolSchemas,
          messages: history,
          sampling: agent.sampling,
          signal: ctx.signal,
        });
        const latencyMs = Date.now() - startedAt;
        const callCost = estimateCost(agent.model.model, result.usage, this.options.pricing);
        tokensUsed += result.usage.inputTokens + result.usage.outputTokens;
        costUsed += callCost;
        const merged = addUsage(usage, result.usage);
        usage.inputTokens = merged.inputTokens;
        usage.outputTokens = merged.outputTokens;

        // Record the call (cost + assistant output) *before* enforcing budgets,
        // so the call we already paid the provider for is always in the log and
        // attributed to `totalCostUsd`.
        await ctx.emit({
          type: "llm.call",
          model: agent.model.model,
          usage: result.usage,
          costUsd: callCost,
          stopReason: result.stopReason,
          latencyMs,
        });
        await ctx.emit({ type: "message.assistant", agentName: agent.name, content: result.content });

        if (tokensUsed > budget.maxTokens) throw new Error("token budget exhausted");
        if (budget.maxCostUsd !== null && costUsed > budget.maxCostUsd) {
          throw new Error("cost budget exhausted");
        }

        const toolUses = result.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (toolUses.length === 0) {
          // No tools requested → terminal turn (regardless of stop reason).
          if (agent.output) {
            const structured = await this.structuredOutput(
              agent, systemPrompt, history, result.content, ctx, budget,
              { iterations, tokensUsed, costUsed, runStartedAt, usage },
            );
            // Two-lane model (D12): a chat turn is one *run per message*; turn-end
            // completes the run (it is NOT a pause). Multi-turn memory comes from
            // the thread transcript (thread-scoped history), not a parked run.
            // Only HITL *within* a turn pauses. `interactive` now just marks the
            // agent as a chat surface; the runner treats it like any other agent.
            await ctx.emit({ type: "run.completed", result: structured.data });
            return structured;
          }
          const text = extractText(result.content);
          await ctx.emit({ type: "run.completed", result: text });
          return { text, usage };
        }
        // Tools requested: the next loop iteration dispatches them (via the
        // pending-tool-uses path), unifying the fresh and resume flows.
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
    if (requiresApproval(agent, name)) {
      const approval = await ctx.requestApproval(name, toolUse.input, toolCallId);
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
      await ctx.emit({ type: "tool.result", toolCallId, name, result: err });
      return toolResultBlock(toolCallId, err);
    }

    // 4. Validate input vs inputSchema — error result so the model can self-correct.
    const validationError = validateToolInput(toolUse.input, tool.inputSchema);
    if (validationError) {
      const err: ToolResult = { content: validationError, isError: true };
      await ctx.emit({ type: "tool.called", toolCallId, name, input: toolUse.input });
      await ctx.emit({ type: "tool.result", toolCallId, name, result: err });
      return toolResultBlock(toolCallId, err);
    }

    // 5. Dispatch.
    await ctx.emit({ type: "tool.called", toolCallId, name, input: toolUse.input });
    let result: ToolResult;
    try {
      result = await tool.invoke(toolUse.input, toolContextFrom(ctx, toolCallId));
    } catch (err) {
      result = { content: err instanceof Error ? err.message : String(err), isError: true };
    }
    // 6. Record.
    await ctx.emit({ type: "tool.result", toolCallId, name, result });
    return toolResultBlock(toolCallId, result);
  }

  /**
   * Structured output: issue a schema-constrained completion using the model's
   * final text as context, validate the response, and retry on failure.
   */
  private async structuredOutput(
    agent: AgentDefinition,
    systemPrompt: string,
    history: import("@render-agents/store").Message[],
    finalContent: ContentBlock[],
    ctx: RunContext,
    budget: ResolvedBudget,
    state: { iterations: number; tokensUsed: number; costUsed: number; runStartedAt: number; usage: import("@render-agents/store").TokenUsage },
  ): Promise<AgentOutput> {
    const schema = agent.output;
    if (!schema) {
      return { text: extractText(finalContent), usage: state.usage };
    }

    const MAX_RETRIES = 3;
    let lastText = extractText(finalContent);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Try parsing the existing text first (model may have already produced valid JSON)
      const parsed = tryParseJson(lastText, schema);
      if (parsed.valid) {
        return { text: lastText, data: parsed.data, usage: state.usage };
      }

      // If first attempt and text isn't JSON, do a schema-constrained completion
      // On retries, feed the validation error back
      state.iterations += 1;
      if (state.iterations > budget.maxIterations) throw new Error("maxIterations reached");

      const retryMessages = [
        ...history,
        { role: "assistant" as const, content: finalContent },
        {
          role: "user" as const,
          content: [{
            type: "text" as const,
            text: attempt === 0
              ? `Please respond with valid JSON matching the required output schema.`
              : `Your previous response was not valid JSON. Error: ${parsed.error}. Please fix and respond with valid JSON only.`,
          }],
        },
      ];

      const startedAt = Date.now();
      const result = await this.model.complete({
        model: agent.model,
        system: systemPrompt,
        tools: [],
        messages: retryMessages,
        sampling: agent.sampling,
        responseFormat: { type: "json_schema", schema },
        signal: ctx.signal,
      });
      const latencyMs = Date.now() - startedAt;
      const callCost = estimateCost(agent.model.model, result.usage, this.options.pricing);
      state.tokensUsed += result.usage.inputTokens + result.usage.outputTokens;
      state.costUsed += callCost;
      const merged = addUsage(state.usage, result.usage);
      state.usage.inputTokens = merged.inputTokens;
      state.usage.outputTokens = merged.outputTokens;

      if (state.tokensUsed > budget.maxTokens) throw new Error("token budget exhausted");
      if (budget.maxCostUsd !== null && state.costUsed > budget.maxCostUsd) {
        throw new Error("cost budget exhausted");
      }

      await ctx.emit({
        type: "llm.call",
        model: agent.model.model,
        usage: result.usage,
        costUsd: callCost,
        stopReason: result.stopReason,
        latencyMs,
      });

      lastText = extractText(result.content);
      const retryParsed = tryParseJson(lastText, schema);
      if (retryParsed.valid) {
        return { text: lastText, data: retryParsed.data, usage: state.usage };
      }
    }

    throw new Error(
      `Structured output validation failed after ${MAX_RETRIES} attempts. ` +
      `Model could not produce valid JSON matching the output schema.`,
    );
  }
}

function resolveBudget(budget?: Budget): ResolvedBudget {
  const rawCost = budget?.maxCostUsd === undefined ? 10 : budget.maxCostUsd;
  const maxCostUsd = rawCost === null || rawCost === 0 ? null : rawCost;
  return {
    maxIterations: budget?.maxIterations ?? 50,
    maxTokens: budget?.maxTokens ?? 1_000_000,
    maxCostUsd,
    maxWallSeconds: budget?.maxWallSeconds ?? null,
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

function toolContextFrom(ctx: RunContext, toolCallId: string): ToolContext {
  return {
    env: (name) => ctx.env(name),
    signal: ctx.signal,
    logger: ctx.logger,
    toolCallId,
    // OAuth tokens for the run's user, resolved (and refreshed) by the context.
    connection: (provider: string) => ctx.connection(provider),
    fetch: ssrfFetch,
  };
}

/**
 * Approval matching that respects multi-tool sources (L2). An agent that mounts
 * the source `github` exposes runtime tools named `github__create_issue`. The
 * author may gate either the whole source (`github`) or a specific expanded
 * tool (`github__create_issue`); both must match.
 */
function requiresApproval(agent: AgentDefinition, expandedToolName: string): boolean {
  const list = agent.permissions?.requireApproval;
  if (!list || list.length === 0) return false;
  if (list.includes(expandedToolName)) return true;
  const sourcePrefix = expandedToolName.includes("__")
    ? expandedToolName.slice(0, expandedToolName.indexOf("__"))
    : undefined;
  return sourcePrefix !== undefined && list.includes(sourcePrefix);
}

/**
 * The unanswered tool_use blocks of the latest assistant turn. Non-empty only
 * when the most recent message is an assistant turn carrying tool calls (the
 * loop always emits the matching `message.tool` immediately after dispatch, so
 * an answered turn is never the last message).
 */
function pendingToolUses(history: import("@render-agents/store").Message[]): ToolUseBlock[] {
  const last = history[history.length - 1];
  if (!last || last.role !== "assistant") return [];
  return last.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

/**
 * Build the system prompt with skill catalog appended (progressive disclosure).
 * Skills are listed as a compact menu; the model loads full content on demand.
 */
function buildSystemPrompt(base: string, skills?: SkillMetadata[]): string {
  if (!skills || skills.length === 0) return base;
  const catalog = skills.map((s) =>
    `- **${s.id}**: ${s.name} — ${s.description} (use when: ${s.whenToUse})`,
  ).join("\n");
  return `${base}\n\n## Available Skills\n\nYou have access to the following skills. Use the \`load_skill\` tool to load a skill's full content when needed.\n\n${catalog}`;
}

/**
 * Build the `load_skill` builtin tool that returns skill content on demand.
 * Only mounted when the agent declares skills.
 */
function buildSkillTool(skills?: SkillMetadata[]): Tool | undefined {
  if (!skills || skills.length === 0) return undefined;
  const skillMap = new Map(skills.map((s) => [s.id, s]));

  return {
    name: "load_skill",
    description: "Load the full content of a declared skill by its id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The skill id to load" },
      },
      required: ["id"],
    },
    async invoke(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { id } = input as { id: string };
      const skill = skillMap.get(id);
      if (!skill) {
        return { content: `Unknown skill id: "${id}". Available: ${[...skillMap.keys()].join(", ")}`, isError: true };
      }
      return { content: skill.content };
    },
  };
}

type ParseResult =
  | { valid: true; data: unknown }
  | { valid: false; error: string };

function tryParseJson(text: string, schema: Record<string, unknown>): ParseResult {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = fenced?.[1]?.trim() ?? trimmed;

  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : "Invalid JSON" };
  }

  // Enforce the declared output schema — valid JSON alone is not enough.
  const schemaError = validateToolInput(data, schema);
  if (schemaError) {
    return { valid: false, error: schemaError };
  }
  return { valid: true, data };
}
