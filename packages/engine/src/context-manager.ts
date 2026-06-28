import type { RunEvent, Message } from "@render-agents/store";
import type { ModelSpec } from "./agent.js";

export type { ModelSpec };

export interface ContextPrepareContext {
  readonly model: ModelSpec;
  readonly agentName: string;
  readonly maxContextTokens: number;
  emit(event: RunEvent): Promise<void>;
}

export interface ContextManager {
  prepare(messages: Message[], ctx: ContextPrepareContext): Promise<Message[]>;
}

export interface CompactionStrategy {
  readonly name: string;
  shouldCompact(messages: Message[], usedTokens: number, maxTokens: number): boolean;
  /** `modelSpec` selects the provider/model used for summarization (defaults to a small tier). */
  compact(messages: Message[], modelSpec?: ModelSpec): Promise<{ messages: Message[]; summary: string }>;
}

/**
 * Wave 0 default: history passes through unchanged. Real compaction (the "auto"
 * strategy: summarize older turns, drop redundant tool output, JIT-retrieve)
 * lands in Sprint 09; the full history always stays in the event log regardless.
 */
export const passThroughContextManager: ContextManager = {
  async prepare(messages: Message[]): Promise<Message[]> {
    return messages;
  },
};
