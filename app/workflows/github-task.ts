import { type TaskContext, type TaskDefinition, task as registerTask } from "@renderinc/sdk/workflows";
import type { z } from "zod";
import { type Claim, type Outcome, type RunControl, type Subject, type TaskResult, withClaim } from "../claims/index.js";
import { requireRepo } from "../config/index.js";
import type { GitHubClient } from "../github/index.js";

/** Test seams shared by tasks attached to a GitHub issue or pull request. */
export interface GitHubTaskDeps {
	gh?: GitHubClient;
	runs?: RunControl;
}

export interface GitHubTaskSpec<Input> {
	/** The name registered in Render Workflows. */
	name: string;
	/** The task name shown in the GitHub status comment. */
	title: string;
	/** Validates input before any work starts. */
	input: z.ZodType<Input>;
	/** Selects the issue or pull request this run owns. */
	subject(input: Input, ctx: GitHubTaskContext): Subject;
	timeoutSeconds: number;
}

export type GitHubTaskContext = Pick<TaskContext, "metadata"> & Partial<Pick<TaskContext, "run">>;

export type GitHubTaskRunner<Deps, Data = undefined> = (ctx: GitHubTaskContext, raw: unknown, deps?: Deps) => Promise<TaskResult<Data>>;

/**
 * A GitHub task has one production definition and one directly callable test seam.
 *
 * `task` runs as a Render Workflows task or subtask. `run` executes the same body
 * in-process with injectable dependencies.
 */
export interface GitHubTask<Deps, Data = undefined> {
	readonly task: TaskDefinition<[raw: unknown], TaskResult<Data>>;
	readonly run: GitHubTaskRunner<Deps, Data>;
}

/**
 * Defines work attached to one GitHub issue or pull request. Every run validates
 * input, resolves the configured repository, checks the actor's permission, and
 * owns the subject's status comment until it finishes.
 */
export function defineGitHubTask<Input extends { repo: string; installationId: number; actor: string }, Data, Deps extends GitHubTaskDeps>(
	spec: GitHubTaskSpec<Input>,
	work: (claim: Claim, input: Input, deps: Deps, ctx: GitHubTaskContext) => Promise<Outcome<Data>>,
): GitHubTask<Deps, Data> {
	const run: GitHubTaskRunner<Deps, Data> = (ctx, raw, deps = {} as Deps) => {
		const input = spec.input.parse(raw);
		const repo = requireRepo(input.repo, input.installationId);
		return withClaim(
			ctx,
			{
				repo,
				subject: spec.subject(input, ctx),
				task: spec.name,
				title: spec.title,
				actor: input.actor,
				mode: ctx.metadata.parentTaskRunId ? "continue" : "replace",
				gh: deps.gh,
				runs: deps.runs,
			},
			(claim) => work(claim, input, deps, ctx),
		);
	};
	// Replaying a run can repeat model spend and durable writes. A new GitHub
	// trigger starts a new run instead.
	const task = registerTask(
		{ name: spec.name, timeoutSeconds: spec.timeoutSeconds, retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 } },
		(ctx, raw: unknown) => run(ctx, raw),
	);
	return { run, task };
}
