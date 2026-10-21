import type { TaskContext } from "@renderinc/sdk/workflows";
import { config, type RepoContext } from "../config/index.js";
import { claimRun, emit, isCurrentRun, type RunClaim, type RunClaimInput } from "../events/index.js";
import { type GitHubClient, githubFor, type RunState } from "../github/index.js";
import { Budget } from "./budget.js";
import { checkPermission } from "./permission.js";
import {
	finishStatus,
	type Stage,
	type RunControl,
	type StatusLink,
	type Subject,
	setStatus,
	subjectName,
	takeOver,
} from "./status.js";
import { traceIds } from "./trace.js";

/** What a stage body gets. */
export interface RunContext {
	gh: GitHubClient;
	repo: RepoContext;
	subject: Subject;
	traceId: string;
	runId: string;
	/** The run's soft dollar threshold; pass every agent call through it. run.finished records actual spend. */
	budget: Budget;
	/** Fails when a newer run has claimed this issue or PR. Call before durable writes. */
	checkpoint(): Promise<void>;
	/** Checks ownership, then shows progress in the status comment. */
	progress(summary: string): Promise<void>;
}

/** How a stage body ended. `summary` is shown on GitHub, so it must be safe to publish. */
export interface RunResult {
	outcome: string;
	summary: string;
	state?: "done" | "failed";
	links?: StatusLink[];
}

/** An expected failure: its message is shown on GitHub and the task succeeds. Anything else fails the task. */
export class RunError extends Error {
	constructor(
		message: string,
		readonly outcome = "failed",
	) {
		super(message);
		this.name = "RunError";
	}
}

/** Internal control flow: a newer run owns this issue or PR. */
class SupersededRun extends Error {}

export interface RunCoordination {
	claim(input: RunClaimInput): Promise<RunClaim>;
	isCurrent(claim: RunClaim): Promise<boolean>;
}

export interface RunOptions {
	repo: RepoContext;
	subject: Subject;
	stage: Stage;
	actor: string;
	gh?: GitHubClient;
	runs?: RunControl;
	coordination?: RunCoordination;
}

export interface RunOutcome {
	state: Exclude<RunState, "running">;
	outcome: string;
	summary: string;
	traceId: string;
	runId: string;
}

/** The lifecycle every stage shares: events, permission check, durable claim, takeover, checkpoints, and final status. */
export async function withRun(
	ctx: Pick<TaskContext, "metadata">,
	opts: RunOptions,
	fn: (run: RunContext) => Promise<RunResult>,
): Promise<RunOutcome> {
	const { repo, subject, stage, actor } = opts;
	const ids = traceIds(ctx);
	const traceId = ids.traceId;
	const runId = ids.runId ?? traceId;
	const gh = opts.gh ?? githubFor(repo);
	const base = { traceId, runId, repo: repo.fullName, subject: subjectName(subject) };
	const coordination = opts.coordination ?? { claim: claimRun, isCurrent: isCurrentRun };
	const startedAt = Date.now();
	const budget = new Budget(config.limits.perRunUsd);

	const status = (state: Exclude<RunState, "running">, summary: string, links?: StatusLink[]) =>
		finishStatus({ gh, number: subject.number, runId, stage, state, summary, links });
	const finished = async (
		state: RunOutcome["state"],
		outcome: string,
		summary: string,
		extra: Record<string, unknown> = {},
	): Promise<RunOutcome> => {
		await emit({
			...base,
			type: "run.finished",
			payload: { stage, state, outcome, durationMs: Date.now() - startedAt, costUsd: budget.spent, ...extra },
		});
		return { state, outcome, summary, traceId, runId };
	};
	const superseded = () => finished("cancelled", "superseded", "a newer run took over.");

	await emit({ ...base, type: "run.started", payload: { stage, actor } });
	try {
		if (!(await checkPermission(gh, actor))) {
			const summary = `@${actor} needs \`${config.minimumPermission}\` permission on this repository to start it.`;
			await status("rejected", summary);
			return await finished("rejected", "permission-denied", summary);
		}
		const claim = await coordination.claim({ ...base, stage, actor });
		const checkpoint = async () => {
			if (!(await coordination.isCurrent(claim))) throw new SupersededRun();
		};
		await takeOver({ gh, subject, stage, runId, runs: opts.runs });
		await checkpoint();
		const progress = async (summary: string) => {
			await checkpoint();
			// GitHub can briefly return the status comment's previous body after an edit.
			// The durable claim, checked on both sides of this write, is authoritative.
			await setStatus({ gh, number: subject.number, runId, stage, state: "running", summary });
			await checkpoint();
		};
		const result = await fn({ gh, repo, subject, traceId, runId, budget, checkpoint, progress });
		await checkpoint();
		const state = result.state ?? "done";
		await status(state, result.summary, result.links);
		await checkpoint();
		return await finished(state, result.outcome, result.summary);
	} catch (error) {
		if (error instanceof SupersededRun) return await superseded();
		if (error instanceof RunError) {
			await status("failed", error.message);
			return await finished("failed", error.outcome, error.message);
		}
		const summary = `something went wrong. Run \`${runId}\` has the details in the Render Dashboard.`;
		await status("failed", summary).catch(() => undefined);
		const message = error instanceof Error ? error.message : String(error);
		await finished("failed", "error", summary, { error: message.slice(0, 500) });
		throw error;
	}
}
