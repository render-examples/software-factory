import type { Agent } from "../agents/types.js";
import type { Sandbox } from "../sandbox/index.js";
import type { Tool } from "../tools/index.js";

export interface RunnerUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

export interface RunnerResult {
	result: string;
	usage: RunnerUsage;
	turns: number;
	transcript: unknown[];
}

export interface AgentRunner {
	readonly name: "claude" | "openai";
	run(
		agent: Agent,
		input: { message: string },
		ctx: {
			runId: string;
			tools: readonly Tool[];
			sandbox?: Sandbox;
			signal?: AbortSignal;
		},
	): Promise<RunnerResult>;
}
