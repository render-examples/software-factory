import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(
	source: Record<string, unknown>,
	...keys: string[]
): number {
	for (const key of keys) {
		if (typeof source[key] === "number") return source[key];
	}
	return 0;
}

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/** Extract total token usage from a result message, including cache tokens. */
export function usageTotals(message: SDKMessage): UsageTotals {
	const raw = message as unknown as Record<string, unknown>;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;

	if (isRecord(raw.modelUsage)) {
		for (const entry of Object.values(raw.modelUsage)) {
			if (!isRecord(entry)) continue;
			inputTokens += tokenCount(entry, "inputTokens", "input_tokens");
			outputTokens += tokenCount(entry, "outputTokens", "output_tokens");
			cacheReadTokens += tokenCount(
				entry,
				"cacheReadInputTokens",
				"cache_read_input_tokens",
			);
			cacheWriteTokens += tokenCount(
				entry,
				"cacheCreationInputTokens",
				"cache_creation_input_tokens",
			);
		}
	}
	if (inputTokens > 0 || outputTokens > 0) {
		return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
	}

	const usage = isRecord(raw.usage) ? raw.usage : undefined;
	if (!usage) {
		return {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
	}
	return {
		inputTokens: tokenCount(usage, "inputTokens", "input_tokens"),
		outputTokens: tokenCount(usage, "outputTokens", "output_tokens"),
		cacheReadTokens: tokenCount(
			usage,
			"cacheReadInputTokens",
			"cache_read_input_tokens",
		),
		cacheWriteTokens: tokenCount(
			usage,
			"cacheCreationInputTokens",
			"cache_creation_input_tokens",
		),
	};
}

export function failureReason(message: SDKMessage): string {
	const raw = message as unknown as Record<string, unknown>;
	if (Array.isArray(raw.errors) && raw.errors.length > 0) {
		return raw.errors.join("; ");
	}
	if (typeof raw.result === "string") return raw.result;
	return String(raw.stop_reason ?? raw.subtype ?? "unknown error");
}
