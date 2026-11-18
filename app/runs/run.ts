import { setTimeout as sleep } from "node:timers/promises";
import type { TaskContext } from "@renderinc/sdk/workflows";
import type { z } from "zod";
import { AgentError, type AgentErrorCode, type RunAgentOptions } from "../agent-runs/index.js";
import { config, type RepoContext } from "../config/index.js";
import { append, type Db, VersionConflict, workflowsDb } from "../db/index.js";
import { type EventSpec, runFinished, runProgress, runRejected, runSandboxAttached, threadLinked } from "../events/index.js";
import { type GitHubClient, githubFor, type RunState } from "../github/index.js";
import { type GitHubThread, githubThread, type ThreadKey } from "../threads/index.js";
import { checkPermission } from "./permission.js";
import { type StatusLink, showRejection, syncStatus, warn } from "./status.js";
import { isCurrent, type RunControl, runEvent, startOnThread, stopTrace, workflowRuns } from "./thread.js";
import { traceIds } from "./trace.js";

/** What the work gets: this task run's identity on its issue or PR. */
export interface Run {
	readonly gh: GitHubClient;
	readonly repo: RepoContext;
	readonly thread: GitHubThread;
	readonly traceId: string;
	readonly runId: string;
	/** The trace this run stopped when it started, and its task runs that were still running. */
	readonly displaced: { traceId: string; runIds: readonly string[] } | null;
	/** Ends the run as superseded once a newer run started on this issue or PR. Call before durable writes. */
	assertCurrent(): Promise<void>;
	/** Asserts the run is current, then publishes `summary` in the status comment. */
	reportProgress(summary: string): Promise<void>;
	/** Records the sandbox, so a run that takes over can terminate it. Call right after opening it. */
	trackSandbox(sandbox: { id: string }): Promise<void>;
	/** runAgent options for `sandbox`, so the agent's events carry this run's trace. */
	agentRunOptions(sandbox: RunAgentOptions["sandbox"]): RunAgentOptions;
	/** Records that work on `thread` runs on this run's thread, so deliveries there are resolved here. */
	linkThread(thread: GitHubThread): Promise<void>;
}

/** How the work ended. `summary` is shown on GitHub, so it must be safe to publish. */
export interface Outcome<Data = undefined> {
	outcome: string;
	summary: string;
	state?: "done" | "failed";
	links?: StatusLink[];
	/** Set when the thread waits for a reply. A comment on it then resumes the trace's root task. */
	waiting?: "reply";
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

export interface RunOptions {
	repo: RepoContext;
	thread: GitHubThread;
	/** The task's registered name; recorded in its events. */
	task: string;
	/** The task's name in the status comment, such as "PR Reviewer". */
	title: string;
	actor: string;
	/** Root runs take over the thread; child runs may only continue their own trace. */
	mode?: "replace" | "continue";
	gh?: GitHubClient;
	runs?: RunControl;
	db?: Db;
}

/**
 * Runs `work` as a task run on the issue or PR. withRun checks the actor's permission, starts the run on the thread
 * (a root run takes over and stops the trace it displaced), records progress and how the run ended, and keeps the
 * status comment in sync as a view. The trace whose run started last owns the thread until its runs finish.
 */
export async function withRun<Data = undefined>(
	ctx: Pick<TaskContext, "metadata">,
	opts: RunOptions,
	work: (run: Run) => Promise<Outcome<Data>>,
): Promise<TaskResult<Data>> {
	const run = new ThreadRun(ctx, opts);
	if (!(await run.authorized())) return await run.reject<Data>();
	if (!(await run.start())) return run.result<Data>("cancelled", SUPERSEDED);
	try {
		await run.stopDisplaced();
		return await run.finish(await work(run));
	} catch (error) {
		return await run.fail<Data>(error);
	}
}

/** Thrown once this run is no longer current. */
class Superseded extends Error {}

const SUPERSEDED = { outcome: "superseded", summary: "a newer run took over." };

/** Ways an agent stops that come from the model or its limits. Any other agent error is the platform's and fails the task. */
const AGENT_STOPS: Partial<Record<AgentErrorCode, string>> = {
	max_turns: "ran out of turns",
	timeout: "timed out",
	no_submission: "ended without submitting a result",
	invalid_submission: "submitted an invalid result",
	output_invalid: "submitted an invalid result",
};

const FINAL_SYNC_ATTEMPTS = 3;
const LINK_ATTEMPTS = 3;

/** The lifecycle behind a Run. Only withRun calls the methods beyond the Run interface. */
class ThreadRun implements Run {
	readonly gh: GitHubClient;
	readonly repo: RepoContext;
	readonly thread: GitHubThread;
	readonly traceId: string;
	readonly runId: string;
	displaced: Run["displaced"] = null;
	readonly #opts: RunOptions;
	readonly #db: Db;
	readonly #key: ThreadKey;
	readonly #startedAt = Date.now();
	/** The thread's latest trace before this run started on it, when that was another trace. */
	#previous: string | null = null;
	/** The status body this run last wrote. */
	#shown: string | undefined;

	constructor(ctx: Pick<TaskContext, "metadata">, opts: RunOptions) {
		({ traceId: this.traceId, runId: this.runId } = traceIds(ctx));
		this.repo = opts.repo;
		this.thread = opts.thread;
		this.gh = opts.gh ?? githubFor(opts.repo);
		this.#db = opts.db ?? workflowsDb();
		this.#key = githubThread(opts.repo.fullName, opts.thread);
		this.#opts = opts;
	}

	async assertCurrent(): Promise<void> {
		if (!(await isCurrent(this.#db, this.#key, this))) throw new Superseded();
	}

	async reportProgress(summary: string): Promise<void> {
		await this.assertCurrent();
		await this.#append(runProgress, { summary });
		await this.#sync();
	}

	async trackSandbox(sandbox: { id: string }): Promise<void> {
		// Recorded before the check: a run that takes over after the check sees this sandbox when it stops this run.
		await this.#append(runSandboxAttached, { sandbox_id: sandbox.id });
		await this.assertCurrent();
	}

	agentRunOptions(sandbox: RunAgentOptions["sandbox"]): RunAgentOptions {
		return { sandbox, traceId: this.traceId, runId: this.runId, thread: this.#key };
	}

	async linkThread(thread: GitHubThread): Promise<void> {
		const key = githubThread(this.repo.fullName, thread);
		const stream = `thread:${key}`;
		const event = { type: threadLinked, stream, thread: key, source: `workflow:${this.runId}`, payload: { to: this.#key } };
		// Recorded once: a rerun that finds the same pull request links it to the same issue. A run starting on the
		// pull request's thread at the same moment conflicts on its stream version, so the link is retried.
		for (let attempt = 1; ; attempt++) {
			try {
				await this.#db.withTx((tx) => append(tx, { ...event, idempotencyKey: `${stream} linked` }));
				return;
			} catch (error) {
				if (!(error instanceof VersionConflict) || attempt >= LINK_ATTEMPTS) throw error;
			}
		}
	}

	authorized(): Promise<boolean> {
		return checkPermission(this.gh, this.#opts.actor);
	}

	/** Records the rejection on the run's own stream; it never starts on the thread, so it displaces nothing. */
	async reject<Data>(): Promise<TaskResult<Data>> {
		const { actor, task, title } = this.#opts;
		const summary = `@${actor} needs \`${config.minimumPermission}\` permission on this repository to start it.`;
		await this.#append(runRejected, { trace_id: this.traceId, task, title, actor, reason: summary });
		const run = { traceId: this.traceId, runId: this.runId, task, title, summary };
		await showRejection(this.#db, this.gh, this.repo.fullName, this.thread, run).catch((error) =>
			warn("could not show the rejection", error, { runId: this.runId }),
		);
		return this.result("rejected", { outcome: "permission_denied", summary });
	}

	/** Starts the run on the thread. Returns false when a child's trace no longer owns it, or newer runs kept winning. */
	async start(): Promise<boolean> {
		const { task, title, actor, mode = "replace" } = this.#opts;
		const started = await startOnThread(this.#db, { thread: this.#key, runId: this.runId, traceId: this.traceId, task, title, actor, mode });
		this.#previous = started?.displaced ?? null;
		return started !== null;
	}

	/** Stops the trace this run displaced. Starting first fences that trace even when stopping it fails or is slow. */
	async stopDisplaced(): Promise<void> {
		if (this.#previous) {
			const { title, actor, runs = workflowRuns() } = this.#opts;
			const runIds = await stopTrace(this.#db, runs, this.#previous, { by: this.runId, summary: `${title} by @${actor} took over.` });
			if (runIds.length) this.displaced = { traceId: this.#previous, runIds };
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
		// A takeover terminates this run's sandbox, so any error can mean a newer run started; that isn't a failure.
		if (error instanceof Superseded || !(await isCurrent(this.#db, this.#key, this).catch(() => true))) {
			return await this.#record("cancelled", SUPERSEDED);
		}
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

	result<Data>(state: TaskResult["state"], { outcome, summary, data }: Outcome<Data>): TaskResult<Data> {
		return { state, outcome, summary, traceId: this.traceId, runId: this.runId, ...(data === undefined ? {} : { data }) };
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

	/** Appends `run.finished`. It changes nothing for a run already recorded as stopped. */
	async #record<Data>(
		state: "done" | "failed" | "cancelled",
		{ outcome, summary, links = [], data, waiting }: Outcome<Data>,
	): Promise<TaskResult<Data>> {
		await this.#append(runFinished, { state, outcome, summary, links, duration_ms: Date.now() - this.#startedAt, waiting });
		return this.result(state, { outcome, summary, data });
	}

	#append<S extends z.ZodType>(type: EventSpec<S>, payload: z.input<S>): Promise<unknown> {
		return this.#db.withTx((tx) => append(tx, runEvent(type, this.runId, this.#key, payload)));
	}

	/** Best effort: the comment is a view, so a GitHub failure is logged and never fails the run. Returns whether it synced. */
	async #sync(): Promise<boolean> {
		try {
			this.#shown = await syncStatus(this.#db, this.gh, this.repo.fullName, this.thread, this.#shown);
			return true;
		} catch (error) {
			warn("could not update the status comment", error, { runId: this.runId, thread: this.#key });
			return false;
		}
	}
}
