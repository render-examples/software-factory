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

export interface Run {
	readonly gh: GitHubClient;
	readonly repo: RepoContext;
	readonly thread: GitHubThread;
	readonly traceId: string;
	readonly runId: string;
	readonly displaced: { traceId: string; runIds: readonly string[] } | null;
	assertCurrent(): Promise<void>;
	reportProgress(summary: string): Promise<void>;
	trackSandbox(sandbox: { id: string }): Promise<void>;
	agentRunOptions(sandbox: RunAgentOptions["sandbox"]): RunAgentOptions;
	linkThread(thread: GitHubThread): Promise<void>;
}

export interface Outcome<Data = undefined> {
	outcome: string;
	summary: string;
	state?: "done" | "failed";
	links?: StatusLink[];
	waiting?: "reply";
	data?: Data;
}

export interface TaskResult<Data = undefined> {
	state: Exclude<RunState, "running">;
	outcome: string;
	summary: string;
	traceId: string;
	runId: string;
	data?: Data;
}

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
	task: string;
	title: string;
	actor: string;
	mode?: "replace" | "continue";
	gh?: GitHubClient;
	runs?: RunControl;
	db?: Db;
}

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

class Superseded extends Error {}

const SUPERSEDED = { outcome: "superseded", summary: "a newer run took over." };

const AGENT_STOPS: Partial<Record<AgentErrorCode, string>> = {
	max_turns: "ran out of turns",
	timeout: "timed out",
	no_submission: "ended without submitting a result",
	invalid_submission: "submitted an invalid result",
	output_invalid: "submitted an invalid result",
};

const FINAL_SYNC_ATTEMPTS = 3;
const LINK_ATTEMPTS = 3;

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
	#previous: string | null = null;
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

	async start(): Promise<boolean> {
		const { task, title, actor, mode = "replace" } = this.#opts;
		const started = await startOnThread(this.#db, { thread: this.#key, runId: this.runId, traceId: this.traceId, task, title, actor, mode });
		this.#previous = started?.displaced ?? null;
		return started !== null;
	}

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

	async fail<Data>(error: unknown): Promise<TaskResult<Data>> {
		if (error instanceof Superseded || !(await isCurrent(this.#db, this.#key, this).catch(() => true))) {
			return await this.#record("cancelled", SUPERSEDED);
		}
		if (error instanceof ExpectedFailure) return await this.#end("failed", { outcome: error.outcome, summary: error.message });
		const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
		if (error instanceof AgentError && AGENT_STOPS[error.code]) {
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

	async #end<Data>(state: "done" | "failed", outcome: Outcome<Data>): Promise<TaskResult<Data>> {
		const result = await this.#record(state, outcome);
		for (let attempt = 1; !(await this.#sync()) && attempt < FINAL_SYNC_ATTEMPTS; attempt++) {
			await sleep(500 * attempt);
		}
		return result;
	}

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
