import type { ContentBlock, Message, RunEvent } from "@render-factory/store";
import type { ModelSpec } from "./agent.js";
import type { ModelClient, CompleteResult } from "./model.js";
import type {
  ContextManager,
  ContextPrepareContext,
  CompactionStrategy,
} from "./context-manager.js";

/**
 * Model context window sizes (tokens). Used to derive `maxContextTokens`
 * as ~75% of the window when not explicitly configured.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-haiku-4-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-7": 200_000,
  "claude-opus-4-6": 200_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-5": 200_000,
  "gpt-5-mini": 128_000,
};

const DEFAULT_WINDOW = 128_000;
const WINDOW_FRACTION = 0.75;
const RECENT_TURNS_TO_KEEP = 6;
const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from messages using a character-based heuristic.
 * Accurate enough for threshold decisions; not for billing.
 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          chars += block.text.length;
          break;
        case "tool_use":
          chars += block.name.length + JSON.stringify(block.input).length;
          break;
        case "tool_result":
          chars += block.content.length;
          break;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Derive the default `maxContextTokens` for a model (75% of window).
 */
export function defaultMaxContextTokens(model: string): number {
  const window = MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_WINDOW;
  return Math.floor(window * WINDOW_FRACTION);
}

/**
 * The `auto` compaction strategy:
 * - Keep recent turns verbatim
 * - Summarize older turns preserving decisions and unresolved items
 * - Drop redundant superseded tool output
 *
 * Uses a model call (small/cheap tier) for summarization.
 */
export class AutoCompactionStrategy implements CompactionStrategy {
  readonly name = "auto";

  constructor(private readonly summarizer: ModelClient) {}

  shouldCompact(_messages: Message[], usedTokens: number, maxTokens: number): boolean {
    return usedTokens > maxTokens;
  }

  async compact(messages: Message[], modelSpec?: ModelSpec): Promise<{ messages: Message[]; summary: string }> {
    if (messages.length <= RECENT_TURNS_TO_KEEP) {
      return { messages, summary: "" };
    }

    // Snap the recent-window boundary to an assistant message so the wire
    // history after the (user-role) summary starts cleanly and never splits an
    // assistant `tool_use` from its following `tool_result` turn. If no safe
    // boundary exists in range, skip compaction rather than emit an invalid
    // history that providers will reject.
    let recentStart = messages.length - RECENT_TURNS_TO_KEEP;
    while (recentStart > 0 && messages[recentStart].role !== "assistant") {
      recentStart--;
    }
    if (recentStart <= 0) {
      return { messages, summary: "" };
    }

    const olderMessages = messages.slice(0, recentStart);
    const recentMessages = messages.slice(recentStart);

    const dedupedOlder = dropSupersededToolOutputs(olderMessages);
    const summaryText = await this.summarize(dedupedOlder, modelSpec);

    const summaryMessage: Message = {
      role: "user",
      content: [{ type: "text", text: `[Context summary of earlier conversation]\n\n${summaryText}` }],
    };

    return {
      messages: [summaryMessage, ...recentMessages],
      summary: summaryText,
    };
  }

  private async summarize(messages: Message[], modelSpec?: ModelSpec): Promise<string> {
    const transcript = messages.map((m) => {
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return `[${m.role}]: ${text.slice(0, 2000)}`;
    }).join("\n\n");

    const result: CompleteResult = await this.summarizer.complete({
      // Summarize with the agent's own provider/model so a single-provider
      // deployment never sends a cross-provider model id to its client.
      model: modelSpec ?? { provider: "anthropic", model: "claude-haiku-4-5" },
      system:
        "You are a conversation summarizer. Produce a concise summary that preserves:\n" +
        "1. All decisions made\n" +
        "2. Unresolved questions or pending items\n" +
        "3. Key facts and context needed for the conversation to continue\n" +
        "4. Tool results that are still relevant\n\n" +
        "Drop redundant information, superseded outputs, and verbose tool responses that have been acted upon.",
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: `Summarize this conversation:\n\n${transcript}` }] }],
      sampling: { temperature: 0, maxOutputTokens: 1024 },
      signal: AbortSignal.timeout(30_000),
    });

    return result.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
}

const LARGE_TOOL_RESULT_CHARS = 2000;
const TOOL_RESULT_KEEP_CHARS = 500;

/**
 * Truncate large tool outputs in the older window before summarization. These
 * messages are about to be replaced by a summary anyway, so verbose tool dumps
 * (file reads, test logs) are trimmed to bound the summarization prompt while
 * keeping a head sample for context.
 */
function dropSupersededToolOutputs(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    const truncated = msg.content.map((block) => {
      if (block.type === "tool_result" && block.content.length > LARGE_TOOL_RESULT_CHARS) {
        return {
          ...block,
          content: block.content.slice(0, TOOL_RESULT_KEEP_CHARS) + "\n[... truncated for context management ...]",
        };
      }
      return block;
    });
    return { ...msg, content: truncated };
  });
}

/**
 * Default context manager using the `auto` compaction strategy.
 * Under threshold: passes through unchanged.
 * Over threshold: compacts and emits `context.compacted`.
 */
export class DefaultContextManager implements ContextManager {
  private strategy: CompactionStrategy;

  constructor(opts: { model: ModelClient; strategy?: CompactionStrategy }) {
    this.strategy = opts.strategy ?? new AutoCompactionStrategy(opts.model);
  }

  async prepare(messages: Message[], ctx: ContextPrepareContext): Promise<Message[]> {
    const usedTokens = estimateTokens(messages);
    const maxTokens = ctx.maxContextTokens || defaultMaxContextTokens(ctx.model.model);

    if (!this.strategy.shouldCompact(messages, usedTokens, maxTokens)) {
      return messages;
    }

    const { messages: compacted } = await this.strategy.compact(messages, ctx.model);

    // If compaction couldn't find a safe boundary it returns the input
    // unchanged — don't emit a no-op context.compacted event in that case.
    if (compacted === messages) {
      return messages;
    }
    const afterTokens = estimateTokens(compacted);

    await ctx.emit({
      type: "context.compacted",
      agentName: ctx.agentName,
      strategy: this.strategy.name,
      beforeTokens: usedTokens,
      afterTokens,
    } as RunEvent);

    return compacted;
  }
}

/**
 * Create a context manager that never compacts. Equivalent to the
 * Wave 0 pass-through but named for explicit opt-out.
 */
export class NoCompactionContextManager implements ContextManager {
  async prepare(messages: Message[]): Promise<Message[]> {
    return messages;
  }
}
