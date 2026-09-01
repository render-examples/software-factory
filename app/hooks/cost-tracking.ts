/**
 * Cost-tracking hook — accumulates token usage per agent run and logs a
 * summary when the agent produces a result.
 */
import type { Hook, HookContext } from "#factory/sdk";

export interface RunUsageSummary {
	agentId: string;
	runId: string;
	totalInputTokens: number;
	totalOutputTokens: number;
	turns: number;
	model: string;
}

const MAX_TRACKED_RUNS = 10_000;

const activeRuns = new Map<
	string,
	{ inputTokens: number; outputTokens: number; turns: number; model: string }
>();

function runKey(ctx: HookContext): string {
	return `${ctx.runId}:${ctx.agentId}`;
}

export const costTrackingHook: Hook = {
	name: "cost-tracking",
	on: ["usage", "result", "error"],
	async handle(event, ctx) {
		const key = runKey(ctx);

		if (event.type === "usage") {
			if (activeRuns.size >= MAX_TRACKED_RUNS && !activeRuns.has(key)) {
				return { action: "continue" };
			}
			const existing = activeRuns.get(key) ?? {
				inputTokens: 0,
				outputTokens: 0,
				turns: 0,
				model: event.usage.model,
			};
			existing.inputTokens += event.usage.inputTokens;
			existing.outputTokens += event.usage.outputTokens;
			existing.turns += 1;
			existing.model = event.usage.model;
			activeRuns.set(key, existing);
			return { action: "continue" };
		}

		const accumulated = activeRuns.get(key);
		if (accumulated && (event.type === "result" || event.type === "error")) {
			if (event.type === "result") {
				const summary: RunUsageSummary = {
					agentId: ctx.agentId,
					runId: ctx.runId,
					totalInputTokens: accumulated.inputTokens,
					totalOutputTokens: accumulated.outputTokens,
					turns: accumulated.turns,
					model: accumulated.model,
				};
				console.log(
					JSON.stringify({ event: "agent_usage_summary", ...summary }),
				);
			}
			activeRuns.delete(key);
		}

		return { action: "continue" };
	},
};
