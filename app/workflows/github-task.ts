import { task as registerTask, type TaskContext, type TaskDefinition } from "@renderinc/sdk/workflows";
import type { z } from "zod";
import { requireRepo } from "../config/index.js";
import type { Db } from "../db/index.js";
import type { GitHubClient } from "../github/index.js";
import { type Outcome, type Run, type RunControl, type TaskResult, withRun } from "../runs/index.js";
import type { GitHubThread } from "../threads/index.js";

/** Test seams shared by tasks attached to a GitHub issue or pull request. */
export interface GitHubTaskDeps {
	gh?: GitHubClient;
	runs?: RunControl;
	db?: Db;
}

export interface GitHubTaskSpec<Input> {
	/** The name registered in Render Workflows. */
	name: string;
	/** The task name shown in the GitHub status comment. */
	title: string;
	/** Validates input before any work starts. */
	input: z.ZodType<Input>;
	/** Selects the issue or pull request this run starts on. */
	thread(input: Input): GitHubThread;
	/** The label that started a root run, if one did, and the issue or pull request it's on. */
	trigger?(input: Input): { label: string; number: number } | undefined;
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
 * starts on its thread: a root run takes it over, and a subtask continues its root.
 * A trigger label is a command, so a root run removes it once it has started.
 */
export function defineGitHubTask<Input extends { repo: string; installationId: number; actor: string }, Data, Deps extends GitHubTaskDeps>(
	spec: GitHubTaskSpec<Input>,
	work: (run: Run, input: Input, deps: Deps, ctx: GitHubTaskContext) => Promise<Outcome<Data>>,
): GitHubTask<Deps, Data> {
	const run: GitHubTaskRunner<Deps, Data> = (ctx, raw, deps = {} as Deps) => {
		const input = spec.input.parse(raw);
		const repo = requireRepo(input.repo, input.installationId);
		const root = !ctx.metadata.parentTaskRunId;
		const trigger = root ? spec.trigger?.(input) : undefined;
		return withRun(
			ctx,
			{
				repo,
				thread: spec.thread(input),
				task: spec.name,
				title: spec.title,
				actor: input.actor,
				mode: root ? "replace" : "continue",
				gh: deps.gh,
				runs: deps.runs,
				db: deps.db,
			},
			async (threadRun) => {
				// Best effort: a label left behind only means a person removes it before applying it again.
				if (trigger) {
					await threadRun.gh.removeLabel(trigger.number, trigger.label).catch((error) => {
						console.error(JSON.stringify({ level: "warn", msg: "could not remove the trigger label", ...trigger, error: String(error) }));
					});
				}
				return work(threadRun, input, deps, ctx);
			},
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
