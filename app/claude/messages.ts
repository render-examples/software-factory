import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(source: Record<string, unknown>, ...keys: string[]): number {
	for (const key of keys) {
		if (typeof source[key] === "number") return source[key];
	}
	return 0;
}

/** Extract total token usage from a result message across SDK versions. */
export function usageTotals(message: SDKMessage): {
	inputTokens: number;
	outputTokens: number;
} {
	const raw = message as unknown as Record<string, unknown>;
	let inputTokens = 0;
	let outputTokens = 0;

	if (isRecord(raw.modelUsage)) {
		for (const entry of Object.values(raw.modelUsage)) {
			if (!isRecord(entry)) continue;
			inputTokens += tokenCount(entry, "inputTokens", "input_tokens");
			outputTokens += tokenCount(entry, "outputTokens", "output_tokens");
		}
	}
	if (inputTokens > 0 || outputTokens > 0) return { inputTokens, outputTokens };

	const usage = isRecord(raw.usage) ? raw.usage : undefined;
	if (!usage) return { inputTokens: 0, outputTokens: 0 };
	return {
		inputTokens: tokenCount(usage, "inputTokens", "input_tokens"),
		outputTokens: tokenCount(usage, "outputTokens", "output_tokens"),
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
