import { AgentError, type BaseRunOptions, type runAgent, type SpecialistName, specialists, synthesizer } from "../../agents/index.js";
import type { Review, SpecialistReport } from "../../contracts/index.js";
import type { Budget } from "../../phases/index.js";
import type { Sandbox } from "../../sandbox/index.js";
import type { Missing } from "./messages.js";

export type RunAgent = typeof runAgent;

export const SPECIALIST_NAMES = Object.keys(specialists) as SpecialistName[];

export interface SpecialistsResult {
	reports: Partial<Record<SpecialistName, SpecialistReport>>;
	missing: Missing[];
}

/**
 * The four specialists, in parallel in one sandbox. Each gets an equal share of what the run has left, with one
 * more share held back for the synthesizer, so none can spend another's. One that fails is reported as missing;
 * the budget still counts its partial cost.
 */
export async function runSpecialists(
	run: RunAgent,
	opts: {
		sandbox: Sandbox;
		message: string;
		vars: { repo: string; baseRef: string };
		budget: Budget;
		base: BaseRunOptions;
	},
): Promise<SpecialistsResult> {
	const shareOf = SPECIALIST_NAMES.length + 1;
	const settled = await Promise.allSettled(
		SPECIALIST_NAMES.map((name) =>
			opts.budget.track(
				(budgetUsd) => run(specialists[name], { message: opts.message, vars: opts.vars }, { ...opts.base, sandbox: opts.sandbox, budgetUsd }),
				{ shareOf },
			),
		),
	);
	const result: SpecialistsResult = { reports: {}, missing: [] };
	settled.forEach((outcome, i) => {
		const name = SPECIALIST_NAMES[i] as SpecialistName;
		if (outcome.status === "fulfilled") result.reports[name] = outcome.value.output;
		else result.missing.push({ name, reason: failureReason(outcome.reason) });
	});
	return result;
}

/** The synthesizer, in this task with no sandbox, with whatever the run has left. Throws what runAgent throws. */
export async function synthesize(
	run: RunAgent,
	opts: {
		message: string;
		repo: string;
		budget: Budget;
		base: BaseRunOptions;
	},
): Promise<Review> {
	const res = await opts.budget.track((budgetUsd) => run(synthesizer, { message: opts.message, vars: { repo: opts.repo } }, { ...opts.base, budgetUsd }));
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
