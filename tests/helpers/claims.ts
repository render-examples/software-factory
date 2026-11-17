import { vi } from "vitest";
import { acquire, type RunControl, runEvent, type Subject } from "../../app/claims/index.js";
import { append, type Db } from "../../app/db/index.js";
import { runSandboxAttached, runStarted, subjectKey } from "../../app/events/index.js";

/** Records a running task run that holds the subject, as withClaim would. `runId` defaults to the trace's root. */
export async function holdClaim(
	db: Db,
	repo: string,
	subject: Subject,
	run: { traceId: string; runId?: string; task?: string; title?: string; sandboxId?: string },
): Promise<void> {
	const key = subjectKey(repo, subject);
	const runId = run.runId ?? run.traceId;
	const mode = runId === run.traceId ? "replace" : "continue";
	await db.withTx(async (tx) => {
		const started = { trace_id: run.traceId, task: run.task ?? "triage", title: run.title ?? "Triage", actor: "someone", mode } as const;
		await append(tx, runEvent(runStarted, runId, key, started));
		if (run.sandboxId) await append(tx, runEvent(runSandboxAttached, runId, key, { sandbox_id: run.sandboxId }));
	});
	if (!(await acquire(db, { subject: key, traceId: run.traceId, runId, mode }))) throw new Error(`${runId} could not claim ${key}`);
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
