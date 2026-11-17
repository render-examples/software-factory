import { vi } from "vitest";
import { append, type Db } from "../../app/db/index.js";
import { runSandboxAttached, runStarted } from "../../app/events/index.js";
import { type GitHubClient, GitHubError, type IssueComment, type Permission, parseMarker } from "../../app/github/index.js";
import { type RunControl, runEvent } from "../../app/runs/index.js";
import { type GitHubThread, githubThread } from "../../app/threads/index.js";

/** Records a running task run started on the thread, as withRun would, without stopping anything. `runId` defaults to the trace's root. */
export async function startRun(
	db: Db,
	repo: string,
	thread: GitHubThread,
	run: { traceId: string; runId?: string; task?: string; title?: string; sandboxId?: string },
): Promise<void> {
	const key = githubThread(repo, thread);
	const runId = run.runId ?? run.traceId;
	const mode = runId === run.traceId ? "replace" : "continue";
	const payload = { run_id: runId, trace_id: run.traceId, task: run.task ?? "triage", title: run.title ?? "Triage", actor: "someone", mode } as const;
	await db.withTx(async (tx) => {
		await append(tx, { type: runStarted, stream: `thread:${key}`, thread: key, source: `workflow:${runId}`, payload });
		if (run.sandboxId) await append(tx, runEvent(runSandboxAttached, runId, key, { sandbox_id: run.sandboxId }));
	});
}

/** The runs projection's row for a task run. */
export async function runRow(
	db: Db,
	runId: string,
): Promise<{ state: string; outcome: string | null; summary: string | null; sandbox_id: string | null }> {
	const { rows } = await db.query<{ state: string; outcome: string | null; summary: string | null; sandbox_id: string | null }>(
		"select state, outcome, summary, sandbox_id from runs where run_id = $1",
		[runId],
	);
	if (!rows[0]) throw new Error(`no run ${runId}`);
	return rows[0];
}

/** Render's view of task runs: `statuses` by task run ID, "succeeded" when absent. */
export class FakeRuns implements RunControl {
	readonly cancelled: string[] = [];
	readonly terminated: string[] = [];
	constructor(readonly statuses: Record<string, string> = {}) {}
	getTaskRun = vi.fn(async (id: string) => ({ status: this.statuses[id] ?? "succeeded" }));
	cancelTaskRun = vi.fn(async (id: string) => {
		this.cancelled.push(id);
		this.statuses[id] = "canceled";
	});
	terminateSandbox = vi.fn(async (id: string) => {
		this.terminated.push(id);
	});
}

const BOT = "software-factory[bot]";

/** The GitHub calls a run makes on its issue or PR: comments, labels, and the actor's permission. */
export class FakeGitHub {
	comments: IssueComment[] = [];
	labels = new Set<string>();
	permissions: Record<string, Permission> = { maintainer: "maintain", alice: "write" };
	/** How many more comment writes fail. */
	outage = 0;
	private nextId = 100;

	createComment = vi.fn(async (_number: number, body: string) => {
		this.down();
		const comment = { id: this.nextId++, body, author: { login: BOT, type: "Bot" }, createdAt: "", updatedAt: "", htmlUrl: "" };
		this.comments.push(comment);
		return { ...comment };
	});
	updateComment = vi.fn(async (id: number, body: string) => {
		this.down();
		const comment = this.comments.find((c) => c.id === id);
		if (!comment) throw new GitHubError(404, "Not Found");
		comment.body = body;
		return { ...comment };
	});
	deleteComment = vi.fn(async (id: number) => {
		this.comments = this.comments.filter((c) => c.id !== id);
	});
	ensureLabel = async () => {};
	addLabels = async (_number: number, labels: readonly string[]) => {
		for (const label of labels) this.labels.add(label);
	};
	removeLabel = async (_number: number, label: string) => {
		this.labels.delete(label);
	};
	getPermission = async (login: string) => this.permissions[login] ?? "none";

	/** The newest status comment's body. */
	status(): string {
		return this.comments.filter((c) => parseMarker(c.body, "status")).at(-1)?.body ?? "";
	}

	asClient(): GitHubClient {
		return this as unknown as GitHubClient;
	}

	private down(): void {
		if (this.outage <= 0) return;
		this.outage--;
		throw new Error("GitHub is down");
	}
}
