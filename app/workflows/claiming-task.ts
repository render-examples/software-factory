import { type TaskContext, task } from "@renderinc/sdk/workflows";
import type { z } from "zod";
import { type Claim, type Outcome, type RunControl, type Subject, type TaskResult, withClaim } from "../claims/index.js";
import { requireRepo } from "../config/index.js";
import type { GitHubClient } from "../github/index.js";

/** Test seams every claiming task takes; each task adds its own. */
export interface ClaimDeps {
	gh?: GitHubClient;
	runs?: RunControl;
}

export interface ClaimingTaskSpec<Input> {
	/** The task's name in Render Workflows, from TASKS; the gateway starts it by this name. */
	name: string;
	/** How the status comment names the task, such as "PR Reviewer". */
	title: string;
	/** Validates the task input the gateway sent. */
	input: z.ZodType<Input>;
	/** The issue or PR the task claims. */
	subject(input: Input): Subject;
	timeoutSeconds: number;
}

/** The handler a claiming task registers, with injectable dependencies for tests. */
export type ClaimingTaskHandler<Deps> = (ctx: Pick<TaskContext, "metadata">, raw: unknown, deps?: Deps) => Promise<TaskResult>;

/**
 * Registers a Workflows task that validates its input, resolves the repository, and runs `work` under a claim on
 * the input's issue or PR (see withClaim). Returns the handler, so tests can call it with fakes.
 */
export function claimingTask<Input extends { repo: string; installationId: number; actor: string }, Deps extends ClaimDeps>(
	spec: ClaimingTaskSpec<Input>,
	work: (claim: Claim, input: Input, deps: Deps) => Promise<Outcome>,
): ClaimingTaskHandler<Deps> {
	const handler: ClaimingTaskHandler<Deps> = (ctx, raw, deps = {} as Deps) => {
		const input = spec.input.parse(raw);
		const repo = requireRepo(input.repo, input.installationId);
		const opts = { repo, subject: spec.subject(input), task: spec.name, title: spec.title, actor: input.actor, gh: deps.gh, runs: deps.runs };
		return withClaim(ctx, opts, (claim) => work(claim, input, deps));
	};
	// Never retried: a retry repeats model spend, and a relabel or a new comment starts a fresh run.
	task(
		{ name: spec.name, timeoutSeconds: spec.timeoutSeconds, retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 } },
		(ctx, raw: unknown) => handler(ctx, raw),
	);
	return handler;
}
