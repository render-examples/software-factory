import type { RunEvent, Message } from "@render-agents/store";
import type { ModelSpec } from "./agent.js";

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
  compact(messages: Message[]): Promise<{ messages: Message[]; summary: string }>;
}
