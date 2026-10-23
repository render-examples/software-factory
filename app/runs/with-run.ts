import type { TaskContext } from "@renderinc/sdk/workflows";
import { AgentError, type AgentErrorCode } from "../agents/index.js";
import { config, type RepoContext } from "../config/index.js";
import { claimRun, emit, isCurrentRun, type RunClaim, type RunClaimInput } from "../events/index.js";
import { type GitHubClient, githubFor, type RunState } from "../github/index.js";
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

/** Ways an agent stops that come from the model or its limits. Any other agent error is the platform's and fails the task. */
const AGENT_STOPS: Partial<Record<AgentErrorCode, string>> = {
	max_turns: "ran out of turns",
	timeout: "timed out",
	no_submission: "ended without submitting a result",
	invalid_submission: "submitted an invalid result",
	output_invalid: "submitted an invalid result",
};

/** An expected failure as a RunError. An agent's own message can quote repository output, so it stays in the logs. */
function expectedFailure(error: unknown): { error: RunError; detail?: string } | null {
	if (error instanceof RunError) return { error };
	if (error instanceof AgentError && AGENT_STOPS[error.code]) {
		return { error: new RunError(`the ${error.agentId} agent ${AGENT_STOPS[error.code]}.`, "agent_stopped"), detail: error.message };
	}
	return null;
}

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
			payload: { stage, state, outcome, durationMs: Date.now() - startedAt, ...extra },
		});
		return { state, outcome, summary, traceId, runId };
	};
	const superseded = () => finished("cancelled", "superseded", "a newer run took over.");

	await emit({ ...base, type: "run.started", payload: { stage, actor } });
	try {
		if (!(await checkPermission(gh, actor))) {
			const summary = `@${actor} needs \`${config.minimumPermission}\` permission on this repository to start it.`;
			await status("rejected", summary);
			return await finished("rejected", "permission_denied", summary);
		}
		const claim = await coordination.claim({ ...base, stage, actor });
		const checkpoint = async () => {
			if (!(await coordination.isCurrent(claim))) throw new SupersededRun();
		};
		await takeOver({ gh, subject, stage, runId, runs: opts.runs });
		await checkpoint();
		const progress = async (summary: string) => {
			await checkpoint();
			if (!(await setStatus({ gh, number: subject.number, runId, stage, state: "running", summary }))) throw new SupersededRun();
			await checkpoint();
		};
		const result = await fn({ gh, repo, subject, traceId, runId, checkpoint, progress });
		await checkpoint();
		const state = result.state ?? "done";
		if (!(await status(state, result.summary, result.links))) throw new SupersededRun();
		return await finished(state, result.outcome, result.summary);
	} catch (error) {
		if (error instanceof SupersededRun) return await superseded();
		const expected = expectedFailure(error);
		if (expected) {
			const { message, outcome } = expected.error;
			await status("failed", message);
			return await finished("failed", outcome, message, expected.detail ? { error: expected.detail.slice(0, 500) } : {});
		}
		const summary = `something went wrong. Run \`${runId}\` has the details in the Render Dashboard.`;
		await status("failed", summary).catch(() => undefined);
		const message = error instanceof Error ? error.message : String(error);
		await finished("failed", "error", summary, { error: message.slice(0, 500) });
		throw error;
	}
}
