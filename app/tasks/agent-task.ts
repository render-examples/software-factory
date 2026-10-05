import { randomUUID } from "node:crypto";
import { type TaskContext, task } from "@renderinc/sdk/workflows";
import { factoryConfig } from "../../factory.config.js";
import { modelFor } from "../config/index.js";
import type { Agent } from "../agents/types.js";
import { redactSecrets } from "../policy/index.js";
import { resolveRunner, type RunnerUsage } from "../runners/index.js";
import { connectSandbox } from "../sandbox/index.js";
import { putArtifact, appendEvent } from "../store/index.js";
import { addRunCost, getRunCost } from "../store/costs.js";
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
 * overestimated rather than underestimated.
 */
const FALLBACK_PRICING = {
	inputPerMTok: 3,
	outputPerMTok: 15,
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

			let usage: RunnerUsage | undefined;
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

				usage = result.usage;

				const usd = computeCost(model, usage);

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
				await emitEvent({
					runId,
					type: "agent.cost",
					phase: "point",
					payload: {
						agentId: agent.id,
						inputTokens: usage.inputTokens,
						outputTokens: usage.outputTokens,
						cacheReadTokens: usage.cacheReadTokens,
						cacheWriteTokens: usage.cacheWriteTokens,
						usd: usd.amount,
						estimated: usd.estimated,
					},
				});

				await storeTranscript(runId, result.transcript);

				console.log(
					JSON.stringify({
						event: "agent_completed",
						agent: agent.id,
						model,
						runner: runner.name,
						inputTokens: usage.inputTokens,
						outputTokens: usage.outputTokens,
						costUsd: usd.amount,
					}),
				);

				return result.result;
			} catch (err) {
				if (usage) {
					const usd = computeCost(model, usage);
					await safeAddCost(runId, usd.amount);
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

	if (usage.cacheReadTokens && rates.cacheReadPerMTok) {
		amount += (usage.cacheReadTokens * rates.cacheReadPerMTok) / 1_000_000;
	}
	if (usage.cacheWriteTokens && rates.cacheWritePerMTok) {
		amount += (usage.cacheWriteTokens * rates.cacheWritePerMTok) / 1_000_000;
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

async function storeTranscript(
	runId: string,
	transcript: unknown[],
): Promise<void> {
	try {
		const redacted = transcript.map((entry) => {
			const json = JSON.stringify(entry);
			return JSON.parse(redactSecrets(json));
		});
		const jsonl = redacted.map((line) => JSON.stringify(line)).join("\n");
		await putArtifact({
			runId,
			kind: "transcript",
			contentType: "application/x-ndjson",
			bytes: Buffer.from(jsonl, "utf-8"),
		});
	} catch (err) {
		console.error("Failed to store transcript artifact:", err);
	}
}
