import type { ContentBlock, TokenUsage, Message } from "@render-agents/store";
import type { ModelSpec, SamplingParams } from "./agent.js";

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CompleteArgs {
  model: ModelSpec;
  system: string;
  tools: ToolSchema[];
  messages: Message[];
  sampling?: SamplingParams;
  responseFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  signal: AbortSignal;
}

export interface CompleteResult {
  content: ContentBlock[];
  usage: TokenUsage;
  stopReason: string;
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partialInput: string };

export interface ModelClient {
  complete(args: CompleteArgs): Promise<CompleteResult>;
  stream?(args: CompleteArgs): AsyncGenerator<ModelStreamEvent, CompleteResult>;
}

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableStatuses: number[];
}

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5": { inputPer1M: 0.80, outputPer1M: 4.00 },
  "claude-sonnet-4-6": { inputPer1M: 3.00, outputPer1M: 15.00 },
  "claude-opus-4-6": { inputPer1M: 15.00, outputPer1M: 75.00 },
};

export function estimateCost(_model: string, _usage: TokenUsage): number {
  throw new Error("not implemented");
}
