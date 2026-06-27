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
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5": { inputPer1M: 1.00, outputPer1M: 5.00, cacheReadPer1M: 0.10, cacheWritePer1M: 1.25 },
  "claude-sonnet-4-6": { inputPer1M: 3.00, outputPer1M: 15.00, cacheReadPer1M: 0.30, cacheWritePer1M: 3.75 },
  "claude-sonnet-4-7": { inputPer1M: 3.00, outputPer1M: 15.00, cacheReadPer1M: 0.30, cacheWritePer1M: 3.75 },
  "claude-opus-4-6": { inputPer1M: 15.00, outputPer1M: 75.00, cacheReadPer1M: 1.50, cacheWritePer1M: 18.75 },
  "gpt-4o": { inputPer1M: 2.50, outputPer1M: 10.00 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.60 },
  "gpt-5": { inputPer1M: 5.00, outputPer1M: 20.00 },
  "gpt-5-mini": { inputPer1M: 0.50, outputPer1M: 2.00 },
};

/**
 * Estimate the USD cost of a single LLM call from per-1M-token pricing.
 *
 * Unpriced (but routable) models return `0` — a loud warning is emitted at
 * load time and repeated at runtime so operators notice. The cost budget
 * is simply not enforced for them (other budgets still apply).
 *
 * Custom pricing is layered in via `createRuntime({ pricing })`.
 */
export function estimateCost(
  model: string,
  usage: TokenUsage,
  pricing: Record<string, ModelPricing> = MODEL_PRICING,
): number {
  const rate = pricing[model];
  if (!rate) {
    warnUnpriced(model);
    return 0;
  }
  const per = 1_000_000;
  const inputCost = (usage.inputTokens / per) * rate.inputPer1M;
  const outputCost = (usage.outputTokens / per) * rate.outputPer1M;
  const cacheReadCost = ((usage.cacheReadTokens ?? 0) / per) * (rate.cacheReadPer1M ?? 0);
  const cacheWriteCost = ((usage.cacheWriteTokens ?? 0) / per) * (rate.cacheWritePer1M ?? rate.inputPer1M);
  const total = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  return Math.round(total * 1e12) / 1e12;
}

/** Merge two usage objects (accumulate tokens across loop turns). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) }
      : {}),
    ...(a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) }
      : {}),
  };
}

const warnedModels = new Set<string>();

function warnUnpriced(model: string): void {
  if (warnedModels.has(model)) return;
  warnedModels.add(model);
  console.warn(
    `[render-agents] Model "${model}" has no pricing entry in MODEL_PRICING. ` +
    `Cost estimation returns $0. Add pricing via createRuntime({ pricing }) ` +
    `or use a known model to enable cost budgets.`,
  );
}
