import { vi } from "vitest";
import { append, type Db } from "../../app/db/index.js";
import { runSandboxAttached, runStarted } from "../../app/events/index.js";
import { type RunControl, runEvent } from "../../app/runs/index.js";
import { type GitHubThread, githubThread } from "../../app/threads/index.js";

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

interface RunRow {
	state: string;
	outcome: string | null;
	summary: string | null;
	sandbox_id: string | null;
	waiting: string | null;
}

export async function runRow(db: Db, runId: string): Promise<RunRow> {
	const { rows } = await db.query<RunRow>("select state, outcome, summary, sandbox_id, waiting from runs where run_id = $1", [runId]);
	if (!rows[0]) throw new Error(`no run ${runId}`);
	return rows[0];
}

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
