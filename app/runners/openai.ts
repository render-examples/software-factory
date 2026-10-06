import { Agent as OpenAIAgent, Runner, tool as sdkTool } from "@openai/agents";
import { z } from "zod";
import { modelFor } from "../config/index.js";
import { checkToolCall, redactSecrets } from "../policy/index.js";
import type { Tool } from "../tools/index.js";
import type { AgentRunner, RunnerResult, RunnerUsage } from "./types.js";
import { RunnerError } from "./types.js";

export const openaiRunner: AgentRunner = {
	name: "openai",

	async run(agent, input, ctx): Promise<RunnerResult> {
		const tools = ctx.tools;
		if (tools.length > 0 && !ctx.sandbox) {
			throw new Error(
				`Agent "${agent.id}" declares tools but was given no sandbox`,
			);
		}

		const model = modelFor(agent.model, "openai");
		const apiKey = process.env.OPENAI_API_KEY?.trim();
		if (!apiKey) {
			throw new Error("OPENAI_API_KEY is required for the OpenAI runner");
		}

		const sandbox = ctx.sandbox;
		const oaiTools = tools.map((tool) =>
			adaptTool(
				tool,
				sandbox as import("../sandbox/index.js").Sandbox,
				ctx.signal,
			),
		);

		const oaiAgent = new OpenAIAgent({
			name: agent.id,
			instructions: agent.prompt,
			model,
			tools: oaiTools,
		});

		const runner = new Runner({
			tracingDisabled: true,
		});

		try {
			const result = await runner.run(oaiAgent, input.message, {
				maxTurns: agent.maxTurns ?? 30,
				signal: ctx.signal,
			});

			const text = redactSecrets(String(result.finalOutput ?? "").trim());
			if (!text) throw new Error(`Agent "${agent.id}" produced no result`);

			const usage = normalizeUsage(result.state.usage);

			return {
				result: text,
				usage,
				turns: countTurns(result),
				transcript: extractTranscript(result),
			};
		} catch (error) {
			const partial = usageFromErrorState(error);
			if (partial) {
				throw new RunnerError(
					error instanceof Error ? error.message : String(error),
					partial,
					error,
				);
			}
			throw error;
		}
	},
};

/** Strip null-valued keys that the OpenAI SDK sends for optional fields. */
function stripNulls(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value !== null) out[key] = value;
	}
	return out;
}

function adaptTool(
	tool: Tool,
	sandbox: import("../sandbox/index.js").Sandbox,
	signal?: AbortSignal,
) {
	return sdkTool({
		name: tool.name,
		description: tool.description,
		parameters: z.object(tool.inputSchema),
		execute: async (toolInput: Record<string, unknown>) => {
			const args = stripNulls(toolInput);
			const reason = checkToolCall(tool.name, args);
			if (reason) throw new Error(reason);
			const result = await tool.invoke(args, { sandbox, signal });
			if (result.isError) throw new Error(result.content);
			return result.content;
		},
	});
}

interface StateUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly inputTokensDetails?: readonly Record<string, number>[];
}

function normalizeUsage(usage: unknown): RunnerUsage {
	if (!usage || typeof usage !== "object") {
		return { inputTokens: 0, outputTokens: 0 };
	}
	const u = usage as StateUsage;
	const details = u.inputTokensDetails ?? [];
	const cacheRead = detailTokens(details, ["cached_tokens", "cachedTokens"]);
	return {
		inputTokens: Math.max(0, (u.inputTokens ?? 0) - cacheRead),
		outputTokens: u.outputTokens ?? 0,
		cacheReadTokens: cacheRead || undefined,
	};
}

function detailTokens(
	details: readonly Record<string, number>[],
	keys: readonly string[],
): number {
	return details.reduce(
		(total, detail) =>
			total + keys.reduce((sum, key) => sum + (Number(detail[key]) || 0), 0),
		0,
	);
}

/**
 * The OpenAI Agents SDK attaches the run state to errors it raises.
 * Extract usage when present so cost is recorded on failure.
 */
function usageFromErrorState(error: unknown): RunnerUsage | undefined {
	const state = (error as { state?: unknown } | null)?.state;
	if (!state || typeof state !== "object") return undefined;
	const usage = (state as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as StateUsage;
	if (typeof u.inputTokens !== "number" || typeof u.outputTokens !== "number") {
		return undefined;
	}
	return normalizeUsage(usage);
}

/** Approximate turns from the number of raw model responses. */
function countTurns(result: { rawResponses?: unknown[] }): number {
	return Array.isArray(result.rawResponses) ? result.rawResponses.length : 1;
}

/** Extract a minimal transcript from the run result. */
function extractTranscript(result: {
	rawResponses?: unknown[];
	finalOutput?: unknown;
}): unknown[] {
	if (Array.isArray(result.rawResponses)) return result.rawResponses;
	return [{ finalOutput: result.finalOutput }];
}
