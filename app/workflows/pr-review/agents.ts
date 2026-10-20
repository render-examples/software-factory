import { AgentError, type BaseRunOptions, prReviewer, type runAgent } from "../../agents/index.js";
import type { Review } from "../../schemas/index.js";
import type { Budget } from "../../runs/index.js";
import type { Sandbox } from "../../sandbox/index.js";

export type RunAgent = typeof runAgent;

/** Runs the reviewer in the PR sandbox with the run's remaining budget. */
export async function reviewPull(
	run: RunAgent,
	opts: {
		sandbox: Sandbox;
		message: string;
		vars: { repo: string; baseRef: string };
		budget: Budget;
		base: BaseRunOptions;
	},
): Promise<Review> {
	const res = await opts.budget.track((budgetUsd) =>
		run(prReviewer, { message: opts.message, vars: opts.vars }, { ...opts.base, sandbox: opts.sandbox, budgetUsd }),
	);
	return res.output;
}

/** Why an agent failed, safe to post: its error code. The message (which can quote sandbox output) stays in the logs. */
export function failureReason(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	console.error(
		JSON.stringify({
			level: "warn",
			msg: "agent failed",
			code: err instanceof AgentError ? err.code : undefined,
			error: message.slice(0, 1000),
		}),
	);
	return err instanceof AgentError ? `stopped with \`${err.code}\`` : "failed unexpectedly";
}
