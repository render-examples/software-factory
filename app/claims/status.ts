import { ClientError, Render } from "@renderinc/sdk";
import type { z } from "zod";
import { append, type Db, type NewEvent, type Queryable, VersionConflict } from "../db/index.js";
import { claimAcquired, claimReleased, type EventSpec, runStopped } from "../events/index.js";
import { type GitHubClient, GitHubError, type RunState, renderMarker } from "../github/index.js";
import { sandboxClient } from "../sandbox/index.js";
import { type GitHubThread, githubThread, type ThreadKey } from "../threads/index.js";

export interface StatusLink {
	label: string;
	url: string;
}

/** On the issue or PR while a trace holds its claim. */
export const WORKING_LABEL = "factory:working";

export type StatusGitHub = Pick<GitHubClient, "createComment" | "updateComment" | "ensureLabel" | "addLabels" | "removeLabel">;

/** The Render calls that stop a previous run, injectable for tests. */
export interface RunControl {
	getTaskRun(taskRunId: string): Promise<{ status: string }>;
	cancelTaskRun(taskRunId: string): Promise<void>;
	/** Idempotent: a sandbox that no longer exists counts as terminated. */
	terminateSandbox(sandboxId: string): Promise<void>;
}

let defaultRuns: RunControl | undefined;

/** The Workflows and Sandbox APIs via the SDK. Reads RENDER_API_KEY and RENDER_WORKSPACE_ID. */
export function workflowRuns(): RunControl {
	if (!defaultRuns) {
		const workflows = new Render().workflows;
		defaultRuns = {
			getTaskRun: (id) => workflows.getTaskRun(id),
			cancelTaskRun: (id) => workflows.cancelTaskRun(id),
			terminateSandbox: (id) => sandboxClient().terminate(id),
		};
	}
	return defaultRuns;
}

/** An event on task run `runId`'s stream about `thread`, written by task run `by`. */
export function runEvent<S extends z.ZodType>(type: EventSpec<S>, runId: string, thread: ThreadKey, payload: z.input<S>, by = runId): NewEvent<S> {
	return { type, stream: `run:${runId}`, thread, source: `workflow:${by}`, payload };
}

/** The trace (root task run) that holds or last held a thread, and its current task run. */
export interface ClaimRecord {
	traceId: string;
	runId: string;
	held: boolean;
	streamVersion: number;
}

export async function readClaim(db: Queryable, thread: ThreadKey): Promise<ClaimRecord | null> {
	const { rows } = await db.query<ClaimRecord>(
		`select trace_id as "traceId", run_id as "runId", state = 'held' as held, stream_version as "streamVersion" from claims where thread = $1`,
		[thread],
	);
	return rows[0] ?? null;
}

const ACQUIRE_ATTEMPTS = 4;

/**
 * Claims `thread` for the run by appending `claim.acquired` at the thread stream's current version: of two runs
 * that read the same claim, only one appends, and the other rereads. A subtask may only continue the trace that
 * holds the claim. Returns the claim it replaced, or null when the run may not claim the thread.
 */
export async function acquire(
	db: Db,
	run: { thread: ThreadKey; traceId: string; runId: string; mode: "replace" | "continue" },
): Promise<{ previous: ClaimRecord | null } | null> {
	for (let attempt = 1; attempt <= ACQUIRE_ATTEMPTS; attempt++) {
		try {
			return await db.withTx(async (tx) => {
				const previous = await readClaim(tx, run.thread);
				if (run.mode === "continue" && !(previous?.held && previous.traceId === run.traceId)) return null;
				await append(
					tx,
					{
						type: claimAcquired,
						stream: `thread:${run.thread}`,
						thread: run.thread,
						source: `workflow:${run.runId}`,
						payload: {
							trace_id: run.traceId,
							run_id: run.runId,
							previous_trace_id: previous?.traceId ?? null,
							previous_run_id: previous?.runId ?? null,
						},
					},
					{ expectedVersion: previous?.streamVersion ?? 0 },
				);
				return { previous };
			});
		} catch (error) {
			if (!(error instanceof VersionConflict)) throw error;
		}
	}
	// Newer claims won every attempt.
	return null;
}

/** Releases the claim if `traceId` still holds it. A run that claims the thread first wins, and nothing is released. */
export async function release(db: Db, thread: ThreadKey, traceId: string, by: string, state: "done" | "failed" | "cancelled"): Promise<void> {
	try {
		await db.withTx(async (tx) => {
			const claim = await readClaim(tx, thread);
			if (!claim?.held || claim.traceId !== traceId) return;
			await append(
				tx,
				{ type: claimReleased, stream: `thread:${thread}`, thread, source: `workflow:${by}`, payload: { trace_id: traceId, state } },
				{ expectedVersion: claim.streamVersion },
			);
		});
	} catch (error) {
		if (!(error instanceof VersionConflict)) throw error;
	}
}

export interface Stop {
	/** The task run doing the stopping. */
	by: string;
	outcome: "superseded" | "cancelled";
	/** What the stopped runs' status says, given whether Render still had the trace running. */
	summary(active: boolean): string;
}

/**
 * Stops a trace: cancels its root run if Render still has it active, terminates the Sandboxes its running task runs
 * recorded, and records those runs stopped. Render kills a cancelled task without running its `finally`, so its
 * Sandbox would otherwise live until its timeout and its runs would stay `running`. Returns whether the root was
 * active and which task runs were still running.
 */
export async function stopRun(db: Db, runs: RunControl, traceId: string, stop: Stop): Promise<{ active: boolean; stopped: string[] }> {
	const { rows } = await db.query<{ runId: string; thread: ThreadKey; sandboxId: string | null }>(
		`select run_id as "runId", thread, sandbox_id as "sandboxId" from runs where trace_id = $1 and state = 'running' order by started_at`,
		[traceId],
	);
	if (!rows.length) return { active: false, stopped: [] };
	const active = await isRunActive(runs, traceId);
	if (active) await cancelActiveRun(runs, traceId);
	for (const { sandboxId } of rows) {
		if (sandboxId)
			await runs.terminateSandbox(sandboxId).catch((error) => warn("could not terminate the stopped run's sandbox", error, { sandboxId }));
	}
	const payload = { by: stop.by, outcome: stop.outcome, active, summary: stop.summary(active) };
	// Oldest first, so the current task run is updated last and the status view shows it.
	await db.withTx(async (tx) => {
		for (const row of rows) await append(tx, runEvent(runStopped, row.runId, row.thread, payload, stop.by));
	});
	return { active, stopped: rows.map((row) => row.runId) };
}

/** Whether a task run is pending or running. A confirmed 404 is finished; unknown state fails closed. */
async function isRunActive(runs: RunControl, taskRunId: string): Promise<boolean> {
	try {
		const { status } = await runs.getTaskRun(taskRunId);
		return status === "pending" || status === "running";
	} catch (error) {
		if (error instanceof ClientError && error.statusCode === 404) return false;
		warn("could not read task run; refusing to assume it finished", error, { taskRunId });
		throw error;
	}
}

/** Cancels a run. A cancel that fails because the run just finished is fine; one that leaves it running throws. */
async function cancelActiveRun(runs: RunControl, taskRunId: string): Promise<void> {
	try {
		await runs.cancelTaskRun(taskRunId);
	} catch (error) {
		if (await isRunActive(runs, taskRunId)) throw error;
	}
}

interface StatusView {
	traceId: string;
	runId: string;
	task: string;
	title: string;
	state: RunState;
	summary: string | null;
	links: StatusLink[];
}

/**
 * Renders the status comment from the thread's claim and whichever of its current task run and root was updated
 * last, then writes the comment and the working label to GitHub, unless the body equals `shown`, the last one this
 * caller wrote. Returns the body. The comment is a view: nothing reads it back.
 */
export async function syncStatus(db: Db, gh: StatusGitHub, repo: string, thread: GitHubThread, shown?: string): Promise<string | undefined> {
	const key = githubThread(repo, thread);
	const { rows } = await db.query<StatusView & { commentId: string | number | null; held: boolean }>(
		`select c.status_comment_id as "commentId", c.state = 'held' as held, c.trace_id as "traceId",
		   r.run_id as "runId", r.task, r.title, r.state, r.summary, coalesce(r.links, '[]') as links
		 from claims c join runs r on r.run_id in (c.run_id, c.trace_id)
		 where c.thread = $1 order by r.updated_seq desc limit 1`,
		[key],
	);
	const view = rows[0];
	if (!view) return undefined;
	const body = statusBody(view, repo, thread);
	if (body === shown) return body;
	// `pg` returns bigint as a string.
	const commentId = view.commentId === null ? null : Number(view.commentId);
	const written = await writeComment(gh, thread.number, commentId, body);
	if (written !== commentId) await db.query("update claims set status_comment_id = $2 where thread = $1", [key, written]);
	if (view.held) {
		await gh.ensureLabel(WORKING_LABEL, "fbca04", "software-factory is working on this");
		await gh.addLabels(thread.number, [WORKING_LABEL]);
	} else {
		await gh.removeLabel(thread.number, WORKING_LABEL);
	}
	return body;
}

/**
 * Shows a rejected run on a thread nothing has claimed, the first time a run is rejected there. A rejected run
 * never holds the claim, and showing every one would let anyone who can comment make the bot comment.
 */
export async function showRejection(
	db: Db,
	gh: StatusGitHub,
	repo: string,
	thread: GitHubThread,
	run: { runId: string; task: string; title: string; summary: string },
): Promise<void> {
	const { rows } = await db.query<{ first: boolean }>(
		`select not exists (select 1 from claims where thread = $1)
		   and not exists (select 1 from runs where thread = $1 and state = 'rejected' and run_id <> $2) as first`,
		[githubThread(repo, thread), run.runId],
	);
	if (!rows[0]?.first) return;
	await gh.createComment(thread.number, statusBody({ ...run, traceId: run.runId, state: "rejected", links: [] }, repo, thread));
}

function statusBody(s: StatusView, repo: string, thread: GitHubThread): string {
	const detail = s.summary ? `: ${s.summary}` : "";
	const line = {
		running: `**${s.title}** is running${detail}`,
		done: `**${s.title}** finished${detail}`,
		failed: `**${s.title}** failed${detail}`,
		cancelled: `**${s.title}** was cancelled${detail}`,
		rejected: `**${s.title}** did not run${detail}`,
	}[s.state];
	const links = s.links.map((link) => `- [${link.label}](${link.url})`);
	const footer = `<sub>run \`${s.runId}\` · events: \`/threads/github/${repo}/${thread.kind}/${thread.number}/stream\`</sub>`;
	const marker = renderMarker("status", { runId: s.runId, traceId: s.traceId, stage: s.task, title: s.title, state: s.state });
	return [line, ...(links.length ? ["", ...links] : []), "", footer, "", marker].join("\n");
}

/** Updates the status comment, or creates it when there is none or someone deleted it. Returns its ID. */
async function writeComment(gh: StatusGitHub, number: number, commentId: number | null, body: string): Promise<number> {
	if (commentId !== null) {
		try {
			return (await gh.updateComment(commentId, body)).id;
		} catch (error) {
			if (!(error instanceof GitHubError && error.status === 404)) throw error;
		}
	}
	return (await gh.createComment(number, body)).id;
}

export function warn(msg: string, error: unknown, fields: Record<string, unknown>): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error(JSON.stringify({ level: "warn", msg, ...fields, error: message }));
}
