import type { Db } from "../db/index.js";
import { type GitHubClient, GitHubError, type RunState, renderMarker } from "../github/index.js";
import { type GitHubThread, githubThread, type ThreadKey } from "../threads/index.js";

export interface StatusLink {
	label: string;
	url: string;
}

/** On the issue or PR while the thread's latest trace has a running run. */
export const WORKING_LABEL = "factory:working";

export type StatusGitHub = Pick<GitHubClient, "createComment" | "updateComment" | "deleteComment" | "ensureLabel" | "addLabels" | "removeLabel">;

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
 * Renders the status comment from the thread's latest trace, then writes the comment and the working label to
 * GitHub, unless the body equals `shown`, the last one this caller wrote. Returns the body. The view shows the run
 * that started last while it runs, and otherwise the trace's root, which reports how the trace ended. The comment
 * is a view: nothing reads it back.
 */
export async function syncStatus(db: Db, gh: StatusGitHub, repo: string, thread: GitHubThread, shown?: string): Promise<string | undefined> {
	const key = githubThread(repo, thread);
	const { rows } = await db.query<StatusView & { commentId: string | number | null; working: boolean }>(
		`select t.status_comment_id as "commentId", t.trace_id as "traceId",
		   exists (select 1 from runs where trace_id = t.trace_id and state = 'running') as working,
		   r.run_id as "runId", r.task, r.title, r.state, r.summary, coalesce(r.links, '[]') as links
		 from threads t join runs r on r.run_id in (t.run_id, t.trace_id)
		 where t.thread = $1
		 order by r.run_id = t.run_id and r.state = 'running' desc, r.run_id = t.trace_id desc
		 limit 1`,
		[key],
	);
	const view = rows[0];
	if (!view) return undefined;
	const body = statusBody(view, repo, thread);
	if (body === shown) return body;
	// `pg` returns bigint as a string.
	const commentId = view.commentId === null ? null : Number(view.commentId);
	const written = await writeComment(gh, thread.number, commentId, body);
	if (written !== commentId) await saveComment(db, gh, key, commentId, written, body);
	if (view.working) {
		await gh.ensureLabel(WORKING_LABEL, "fbca04", "software-factory is working on this");
		await gh.addLabels(thread.number, [WORKING_LABEL]);
	} else {
		await gh.removeLabel(thread.number, WORKING_LABEL);
	}
	return body;
}

/**
 * Records the comment this sync created in place of `replaced`, unless another sync recorded one first. Then that
 * one is the status comment: this one is deleted and the other gets the body.
 */
async function saveComment(db: Db, gh: StatusGitHub, thread: ThreadKey, replaced: number | null, created: number, body: string): Promise<void> {
	const saved = await db.query(
		"update threads set status_comment_id = $3 where thread = $1 and status_comment_id is not distinct from $2::bigint returning thread",
		[thread, replaced, created],
	);
	if (saved.rows.length) return;
	await gh.deleteComment(created).catch((error) => warn("could not delete a duplicate status comment", error, { thread, commentId: created }));
	const { rows } = await db.query<{ commentId: string | number | null }>(`select status_comment_id as "commentId" from threads where thread = $1`, [
		thread,
	]);
	const winner = rows[0]?.commentId;
	if (winner != null) await gh.updateComment(Number(winner), body);
}

/**
 * Shows a rejected run on a thread with no runs, the first time a run is rejected there. A rejected run never
 * starts on the thread, and showing every one would let anyone who can comment make the bot comment.
 */
export async function showRejection(
	db: Db,
	gh: StatusGitHub,
	repo: string,
	thread: GitHubThread,
	run: { traceId: string; runId: string; task: string; title: string; summary: string },
): Promise<void> {
	const { rows } = await db.query<{ first: boolean }>("select not exists (select 1 from runs where thread = $1 and run_id <> $2) as first", [
		githubThread(repo, thread),
		run.runId,
	]);
	if (!rows[0]?.first) return;
	await gh.createComment(thread.number, statusBody({ ...run, state: "rejected", links: [] }, repo, thread));
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
