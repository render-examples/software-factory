import { setTimeout as sleep } from "node:timers/promises";
import type { TaskContext } from "@renderinc/sdk/workflows";
import type { z } from "zod";
import { AgentError, type AgentErrorCode, type RunAgentOptions } from "../agents/index.js";
import { config, type RepoContext } from "../config/index.js";
import { append, type Db, workflowsDb } from "../db/index.js";
import { type EventSpec, runFinished, runProgress, runRejected, runSandboxAttached, runStarted, subjectKey } from "../events/index.js";
import { type GitHubClient, githubFor, type RunState } from "../github/index.js";
import { checkPermission } from "./permission.js";
import {
	acquire,
	type RunControl,
	readClaim,
	release,
	runEvent,
	type StatusLink,
	type Subject,
	showRejection,
	stopRun,
	subjectName,
	syncStatus,
	warn,
	workflowRuns,
} from "./status.js";
import { traceIds } from "./trace.js";

/** What the work gets: this task run's identity and its claim on the issue or PR. */
export interface Claim {
	readonly gh: GitHubClient;
	readonly repo: RepoContext;
	readonly subject: Subject;
	readonly traceId: string;
	readonly runId: string;
	/** Ends the run as superseded once a newer run owns this issue or PR. Call before durable writes. */
	assertCurrent(): Promise<void>;
	/** Asserts the claim, then publishes `summary` in the status comment. */
	reportProgress(summary: string): Promise<void>;
	/** Records the sandbox, so a run that stops this one can terminate it. Call right after opening it. */
	trackSandbox(sandbox: { id: string }): Promise<void>;
	/** runAgent options for `sandbox`, so the agent's events carry this run's trace. */
	agentRunOptions(sandbox: RunAgentOptions["sandbox"]): RunAgentOptions;
}

/** How the work ended. `summary` is shown on GitHub, so it must be safe to publish. */
export interface Outcome<Data = undefined> {
	outcome: string;
	summary: string;
	state?: "done" | "failed";
	links?: StatusLink[];
	/** Typed data for a parent task. It is returned to Workflows, never rendered on GitHub. */
	data?: Data;
}

/** What a GitHub task returns to Render Workflows. */
export interface TaskResult<Data = undefined> {
	state: Exclude<RunState, "running">;
	outcome: string;
	summary: string;
	traceId: string;
	runId: string;
	data?: Data;
}

/** An expected failure: its message is shown on GitHub and the task succeeds. Anything else fails the task. */
export class ExpectedFailure extends Error {
	constructor(
		message: string,
		readonly outcome = "failed",
	) {
		super(message);
		this.name = "ExpectedFailure";
	}
}

export interface ClaimOptions {
	repo: RepoContext;
	subject: Subject;
	/** The task's registered name; recorded in its events. */
	task: string;
	/** The task's name in the status comment, such as "PR Reviewer". */
	title: string;
	actor: string;
	/** Root tasks may replace another root; subtasks may only continue their own root. */
	mode?: "replace" | "continue";
	gh?: GitHubClient;
	runs?: RunControl;
	db?: Db;
}

/**
 * Runs `work` while this task run claims the issue or PR. The claim is the subject's latest `claim.acquired` in
 * Postgres. withClaim checks the actor's permission, claims the subject and stops the previous holder, records
 * progress and how the run ended, and keeps the status comment in sync as a view.
 */
export async function withClaim<Data = undefined>(
	ctx: Pick<TaskContext, "metadata">,
	opts: ClaimOptions,
	work: (claim: Claim) => Promise<Outcome<Data>>,
): Promise<TaskResult<Data>> {
	const run = new ClaimedRun(ctx, opts);
	try {
		await run.start();
		if (!(await run.authorized())) return await run.reject<Data>();
		await run.acquire();
		return await run.finish(await work(run));
	} catch (error) {
		return await run.fail<Data>(error);
	}
}

/** Thrown once another trace holds the claim. */
class Superseded extends Error {}

/** Ways an agent stops that come from the model or its limits. Any other agent error is the platform's and fails the task. */
const AGENT_STOPS: Partial<Record<AgentErrorCode, string>> = {
	max_turns: "ran out of turns",
	timeout: "timed out",
	no_submission: "ended without submitting a result",
	invalid_submission: "submitted an invalid result",
	output_invalid: "submitted an invalid result",
};

const FINAL_SYNC_ATTEMPTS = 3;

/** The lifecycle behind a Claim. Only withClaim calls the methods beyond the Claim interface. */
class ClaimedRun implements Claim {
	readonly gh: GitHubClient;
	readonly repo: RepoContext;
	readonly subject: Subject;
	readonly traceId: string;
	readonly runId: string;
	readonly #opts: ClaimOptions;
	readonly #db: Db;
	/** The subject's key in the log. */
	readonly #key: string;
	readonly #startedAt = Date.now();
	/** The status body this run last wrote. */
	#shown: string | undefined;

	constructor(ctx: Pick<TaskContext, "metadata">, opts: ClaimOptions) {
		({ traceId: this.traceId, runId: this.runId } = traceIds(ctx));
		this.repo = opts.repo;
		this.subject = opts.subject;
		this.gh = opts.gh ?? githubFor(opts.repo);
		this.#db = opts.db ?? workflowsDb();
		this.#key = subjectKey(opts.repo.fullName, opts.subject);
		this.#opts = opts;
	}

	async assertCurrent(): Promise<void> {
		const claim = await readClaim(this.#db, this.#key);
		if (!claim?.held || claim.traceId !== this.traceId) throw new Superseded();
	}

	async reportProgress(summary: string): Promise<void> {
		await this.assertCurrent();
		await this.#append(runProgress, { summary });
		await this.#sync();
	}

	async trackSandbox(sandbox: { id: string }): Promise<void> {
		// Recorded before the check: a run that claims the subject after the check sees this sandbox when it stops this run.
		await this.#append(runSandboxAttached, { sandbox_id: sandbox.id });
		await this.assertCurrent();
	}

	agentRunOptions(sandbox: RunAgentOptions["sandbox"]): RunAgentOptions {
		return { sandbox, traceId: this.traceId, runId: this.runId, repo: this.repo.fullName, subject: subjectName(this.subject) };
	}

	async start(): Promise<void> {
		const { task, title, actor, mode = "replace" } = this.#opts;
		await this.#append(runStarted, { trace_id: this.traceId, task, title, actor, mode });
	}

	authorized(): Promise<boolean> {
		return checkPermission(this.gh, this.#opts.actor);
	}

	async reject<Data>(): Promise<TaskResult<Data>> {
		const { actor, task, title } = this.#opts;
		const summary = `@${actor} needs \`${config.minimumPermission}\` permission on this repository to start it.`;
		await this.#append(runRejected, { actor, reason: summary });
		await showRejection(this.#db, this.gh, this.repo.fullName, this.subject, { runId: this.runId, task, title, summary }).catch((error) =>
			warn("could not show the rejection", error, { runId: this.runId }),
		);
		return this.#result("rejected", { outcome: "permission_denied", summary });
	}

	/**
	 * Claims the subject, then stops the previous holder. Claiming first fences the previous run even when stopping
	 * it fails or is slow: its next ownership check fails.
	 */
	async acquire(): Promise<void> {
		const claimed = await acquire(this.#db, { subject: this.#key, traceId: this.traceId, runId: this.runId, mode: this.#opts.mode ?? "replace" });
		if (!claimed) throw new Superseded();
		const { previous } = claimed;
		if (previous?.held && previous.traceId !== this.traceId) {
			const stop = { by: this.runId, outcome: "superseded", summary: () => "a newer run took over." } as const;
			await stopRun(this.#db, this.#opts.runs ?? workflowRuns(), previous.traceId, stop).catch((error) =>
				warn("could not stop the previous run", error, { traceId: previous.traceId }),
			);
		}
		await this.#sync();
	}

	async finish<Data>(outcome: Outcome<Data>): Promise<TaskResult<Data>> {
		await this.assertCurrent();
		return await this.#end(outcome.state ?? "done", outcome);
	}

	/**
	 * A superseded run and an expected failure end the task normally. Anything else is reported on GitHub without
	 * its message, which can hold secrets or repository output, and rethrown so the task fails.
	 */
	async fail<Data>(error: unknown): Promise<TaskResult<Data>> {
		if (error instanceof Superseded) return await this.#record("cancelled", { outcome: "superseded", summary: "a newer run took over." });
		if (error instanceof ExpectedFailure) return await this.#end("failed", { outcome: error.outcome, summary: error.message });
		const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
		if (error instanceof AgentError && AGENT_STOPS[error.code]) {
			// The agent's own message can quote repository output, so it goes to the logs, not GitHub or the event log.
			warn("agent stopped", message, { runId: this.runId, agentId: error.agentId });
			return await this.#end("failed", { outcome: "agent_stopped", summary: `the ${error.agentId} agent ${AGENT_STOPS[error.code]}.` });
		}
		warn("run failed", message, { traceId: this.traceId, runId: this.runId });
		const summary = `something went wrong. Run \`${this.runId}\` has the details in the Render Dashboard.`;
		await this.#end("failed", { outcome: "error", summary }).catch(() => undefined);
		throw error;
	}

	/** Records how the run ended and shows it on GitHub. */
	async #end<Data>(state: "done" | "failed", outcome: Outcome<Data>): Promise<TaskResult<Data>> {
		const result = await this.#record(state, outcome);
		// Retried so a brief GitHub outage doesn't leave the comment saying the run is still going.
		for (let attempt = 1; !(await this.#sync()) && attempt < FINAL_SYNC_ATTEMPTS; attempt++) {
			await sleep(500 * attempt);
		}
		return result;
	}

	/** Appends `run.finished`; a root run also releases the claim if its trace still holds it. */
	async #record<Data>(state: "done" | "failed" | "cancelled", { outcome, summary, links = [], data }: Outcome<Data>): Promise<TaskResult<Data>> {
		await this.#append(runFinished, { state, outcome, summary, links, duration_ms: Date.now() - this.#startedAt });
		if (this.traceId === this.runId) await release(this.#db, this.#key, this.traceId, this.runId, state);
		return this.#result(state, { outcome, summary, data });
	}

	#result<Data>(state: TaskResult["state"], { outcome, summary, data }: Outcome<Data>): TaskResult<Data> {
		return { state, outcome, summary, traceId: this.traceId, runId: this.runId, ...(data === undefined ? {} : { data }) };
	}

	#append<S extends z.ZodType>(type: EventSpec<S>, payload: z.input<S>): Promise<unknown> {
		return this.#db.withTx((tx) => append(tx, runEvent(type, this.runId, this.#key, payload)));
	}

	/** Best effort: the comment is a view, so a GitHub failure is logged and never fails the run. Returns whether it synced. */
	async #sync(): Promise<boolean> {
		try {
			this.#shown = await syncStatus(this.#db, this.gh, this.repo.fullName, this.subject, this.#shown);
			return true;
		} catch (error) {
			warn("could not update the status comment", error, { runId: this.runId, subject: this.#key });
			return false;
		}
	}
}
