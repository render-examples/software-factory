import { randomUUID } from "node:crypto";
import { type TaskContext, task } from "@renderinc/sdk/workflows";
import { factoryConfig } from "../../factory.config.js";
import { modelFor } from "../config/index.js";
import type { Agent } from "../agents/index.js";
import { redactSecrets } from "../policy/index.js";
import {
	resolveRunner,
	RunnerError,
	type RunnerUsage,
} from "../runners/index.js";
import { connectSandbox } from "../sandbox/index.js";
import { putArtifact, appendEvent } from "../store/index.js";
import { addRunCost, getRunCost } from "../store/index.js";
import { z } from "zod";
import { BudgetExceededError } from "./errors.js";

export const agentTaskInputSchema = z.object({
	runId: z.string().min(1),
	message: z.string().min(1),
	sandboxId: z.string().optional(),
});

export type AgentTaskInput = z.infer<typeof agentTaskInputSchema>;

/**
 * Fallback pricing when a model has no entry in `factoryConfig.pricing`.
 * Conservatively set near Claude Sonnet 4 rates so unknown models are
 * overestimated rather than underestimated. Cache rates follow the
 * typical discount/premium: reads at 0.1× input, writes at 1.25× input.
 */
const FALLBACK_PRICING = {
	inputPerMTok: 3,
	outputPerMTok: 15,
	cacheReadPerMTok: 0.3,
	cacheWritePerMTok: 3.75,
} as const;

/** Turn an Agent into a Render Workflows task. */
export function agentTask(agent: Agent) {
	return task(
		{ name: agent.id, plan: agent.plan },
		async function runAgent(
			_ctx: TaskContext,
			rawInput: unknown,
		): Promise<string> {
			const input = agentTaskInputSchema.parse(rawInput);
			const { runId, message, sandboxId } = input;

			const currentCost = await getRunCost(runId);
			if (currentCost >= factoryConfig.limits.perRunUsd) {
				throw new BudgetExceededError(
					runId,
					currentCost,
					factoryConfig.limits.perRunUsd,
				);
			}

			const runner = resolveRunner(agent);
			const runnerName = agent.runner ?? factoryConfig.agents.runner;
			const model = modelFor(agent.model, runnerName);
			const tools = agent.tools ?? [];
			const spanId = randomUUID();

			await emitEvent({
				runId,
				type: "agent.run",
				spanId,
				phase: "start",
				payload: {
					agentId: agent.id,
					runner: runner.name,
					model,
				},
			});

			try {
				const result = await runner.run(
					agent,
					{ message },
					{
						runId,
						tools,
						sandbox: sandboxId ? connectSandbox(sandboxId) : undefined,
					},
				);

				const usd = computeCost(model, result.usage);

				await safeAddCost(runId, usd.amount);

				await emitEvent({
					runId,
					type: "agent.run",
					spanId,
					phase: "end",
					payload: {
						agentId: agent.id,
						runner: runner.name,
						model,
						turns: result.turns,
					},
				});
				await emitCostEvent(runId, agent.id, result.usage, usd);

				await storeTranscript(runId, result.transcript);

				console.log(
					JSON.stringify({
						event: "agent_completed",
						agent: agent.id,
						model,
						runner: runner.name,
						inputTokens: result.usage.inputTokens,
						outputTokens: result.usage.outputTokens,
						costUsd: usd.amount,
					}),
				);

				return result.result;
			} catch (err) {
				const usage = err instanceof RunnerError ? err.usage : undefined;
				if (usage) {
					const usd = computeCost(model, usage);
					await safeAddCost(runId, usd.amount);
					await emitCostEvent(runId, agent.id, usage, usd);
				}

				await emitEvent({
					runId,
					type: "agent.run",
					spanId,
					phase: "end",
					payload: {
						agentId: agent.id,
						runner: runner.name,
						model,
						error: true,
					},
				});

				throw err;
			}
		},
	);
}

interface CostResult {
	amount: number;
	estimated: boolean;
}

function computeCost(model: string, usage: RunnerUsage): CostResult {
	const pricing = factoryConfig.pricing[model];
	const estimated = !pricing;
	const rates = pricing ?? FALLBACK_PRICING;

	let amount =
		(usage.inputTokens * rates.inputPerMTok +
			usage.outputTokens * rates.outputPerMTok) /
		1_000_000;

	if (usage.cacheReadTokens) {
		const rate = rates.cacheReadPerMTok ?? 0;
		amount += (usage.cacheReadTokens * rate) / 1_000_000;
	}
	if (usage.cacheWriteTokens) {
		const rate = rates.cacheWritePerMTok ?? 0;
		amount += (usage.cacheWriteTokens * rate) / 1_000_000;
	}

	return { amount, estimated };
}

async function safeAddCost(runId: string, usd: number): Promise<void> {
	try {
		await addRunCost(runId, usd);
	} catch (err) {
		console.error("Failed to record run cost:", err);
	}
}

async function emitEvent(input: {
	runId: string;
	type: string;
	spanId?: string;
	phase?: "start" | "end" | "point";
	payload?: Record<string, unknown>;
}): Promise<void> {
	try {
		await appendEvent(input);
	} catch (err) {
		console.error(`Failed to emit ${input.type} event:`, err);
	}
}

async function emitCostEvent(
	runId: string,
	agentId: string,
	usage: RunnerUsage,
	usd: CostResult,
): Promise<void> {
	await emitEvent({
		runId,
		type: "agent.cost",
		phase: "point",
		payload: {
			agentId,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens,
			cacheWriteTokens: usage.cacheWriteTokens,
			usd: usd.amount,
			estimated: usd.estimated,
		},
	});
}

/**
 * Store the transcript as a JSONL artifact. Redacts secrets on the
 * final JSONL string to avoid breaking JSON structure, and caps
 * the output to limits.artifactBytes keeping head and tail lines.
 */
async function storeTranscript(
	runId: string,
	transcript: unknown[],
): Promise<void> {
	try {
		const jsonl = redactSecrets(
			transcript.map((entry) => JSON.stringify(entry)).join("\n"),
		);
		const maxBytes = factoryConfig.limits.artifactBytes;
		const bytes = Buffer.from(jsonl, "utf-8");
		const payload =
			bytes.length <= maxBytes ? bytes : truncateJsonl(bytes, maxBytes);
		await putArtifact({
			runId,
			kind: "transcript",
			contentType: "application/x-ndjson",
			bytes: payload,
		});
	} catch (err) {
		console.error("Failed to store transcript artifact:", err);
	}
}

const TRUNCATION_MARKER = '\n{"__truncated__":true}\n';

/**
 * Keep the first and last lines of JSONL within a byte budget,
 * inserting a truncation marker in the middle.
 */
function truncateJsonl(buf: Buffer, maxBytes: number): Buffer {
	const marker = Buffer.from(TRUNCATION_MARKER, "utf-8");
	const half = Math.floor((maxBytes - marker.length) / 2);
	if (half <= 0) return buf.subarray(0, maxBytes);

	const head = buf.subarray(0, half);
	const tail = buf.subarray(buf.length - half);
	return Buffer.concat([head, marker, tail]);
}
