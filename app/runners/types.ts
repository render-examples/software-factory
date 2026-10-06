import type { Agent } from "../agents/index.js";
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

/**
 * Thrown by runners when the model call fails but partial token usage
 * is available (e.g. Claude error result messages, OpenAI run state).
 * `agentTask` catches this to record cost even on failure.
 */
export class RunnerError extends Error {
	readonly usage: RunnerUsage | undefined;

	constructor(message: string, usage?: RunnerUsage, cause?: unknown) {
		super(message, { cause });
		this.name = "RunnerError";
		this.usage = usage;
	}
}
