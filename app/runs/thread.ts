import { ClientError, Render } from "@renderinc/sdk";
import type { z } from "zod";
import { append, type Db, type NewEvent, type Queryable, VersionConflict } from "../db/index.js";
import { type EventSpec, runCleanedUp, runStarted, runStopped } from "../events/index.js";
import { sandboxClient } from "../sandbox/index.js";
import type { ThreadKey } from "../threads/index.js";
import { warn } from "./status.js";

export interface RunControl {
	getTaskRun(taskRunId: string): Promise<{ status: string }>;
	cancelTaskRun(taskRunId: string): Promise<void>;
	terminateSandbox(sandboxId: string): Promise<void>;
}

let defaultRuns: RunControl | undefined;

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

export function runEvent<S extends z.ZodType>(type: EventSpec<S>, runId: string, thread: ThreadKey, payload: z.input<S>, by = runId): NewEvent<S> {
	return { type, stream: `run:${runId}`, thread, source: `workflow:${by}`, payload };
}

export type StartingRun = Omit<z.input<typeof runStarted.payload>, "run_id" | "trace_id"> & {
	thread: ThreadKey;
	runId: string;
	traceId: string;
	replyTo?: string;
};

const START_ATTEMPTS = 4;

export async function startOnThread(db: Db, run: StartingRun): Promise<{ displaced: string | null } | null> {
	const { thread, runId, traceId, replyTo, ...started } = run;
	for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
		try {
			return await db.withTx(async (tx) => {
				const { rows } = await tx.query<{ traceId: string | null; version: number; replyWaiting: string | null }>(
					`select (select trace_id from threads where thread = $1) as "traceId",
					   (select coalesce(max(stream_version), 0) from events where stream = $2) as version,
					   (select waiting from runs where run_id = $3) as "replyWaiting"`,
					[thread, `thread:${thread}`, replyTo ?? ""],
				);
				const latest = rows[0] ?? { traceId: null, version: 0, replyWaiting: null };
				if (run.mode === "continue" && latest.traceId !== traceId) return null;
				if (run.mode === "reply" && (latest.traceId !== replyTo || latest.replyWaiting !== "reply")) return null;
				const event = {
					type: runStarted,
					stream: `thread:${thread}`,
					thread,
					source: `workflow:${runId}`,
					payload: { ...started, run_id: runId, trace_id: traceId },
				};
				await append(tx, event, { expectedVersion: latest.version });
				return { displaced: latest.traceId === traceId ? null : latest.traceId };
			});
		} catch (error) {
			if (!(error instanceof VersionConflict)) throw error;
		}
	}
	return null;
}

export async function isCurrent(db: Queryable, thread: ThreadKey, run: { traceId: string; runId: string }): Promise<boolean> {
	const { rows } = await db.query(
		"select 1 from threads t join runs r on r.run_id = $3 where t.thread = $1 and t.trace_id = $2 and r.state = 'running'",
		[thread, run.traceId, run.runId],
	);
	return rows.length > 0;
}

export interface Cleanup {
	confirmed: string[];
	unconfirmed: string[];
}

export async function stopTrace(
	db: Db,
	runs: RunControl,
	traceId: string,
	stop: { by: string; summary: string },
): Promise<{ runIds: string[]; unconfirmed: string[] }> {
	const { rows } = await db.query<{ runId: string; thread: ThreadKey; sandboxId: string | null }>(
		`select run_id as "runId", thread, sandbox_id as "sandboxId" from runs where trace_id = $1 and state = 'running'`,
		[traceId],
	);
	if (!rows.length) return { runIds: [], unconfirmed: [] };
	const cancel = await cancelIfActive(runs, traceId);
	const failedSandboxes = new Set<string>();
	for (const { sandboxId } of rows) {
		if (sandboxId && !(await terminate(runs, sandboxId))) failedSandboxes.add(sandboxId);
	}
	await db.withTx(async (tx) => {
		for (const row of rows) {
			const taskRun = cancel === "failed" && row.runId === traceId ? traceId : undefined;
			const sandboxes = row.sandboxId && failedSandboxes.has(row.sandboxId) ? [row.sandboxId] : [];
			const unconfirmed = taskRun || sandboxes.length ? { unconfirmed: { ...(taskRun && { task_run: taskRun }), sandboxes } } : {};
			await append(tx, runEvent(runStopped, row.runId, row.thread, { ...stop, active: cancel !== "inactive", ...unconfirmed }, stop.by));
		}
	});
	return { runIds: rows.map((row) => row.runId), unconfirmed: [...(cancel === "failed" ? [traceId] : []), ...failedSandboxes] };
}

export async function retryCleanup(db: Db, control: () => RunControl, thread: ThreadKey, by: string): Promise<Cleanup> {
	const { rows } = await db.query<{ runId: string; pending: { task_run?: string; sandboxes: string[] } }>(
		`select run_id as "runId", cleanup_pending as pending from runs where thread = $1 and cleanup_pending is not null`,
		[thread],
	);
	const cleanup: Cleanup = { confirmed: [], unconfirmed: [] };
	for (const { runId, pending } of rows) {
		const runs = control();
		const resources = [...(pending.task_run ? [pending.task_run] : []), ...pending.sandboxes];
		let stopped = !pending.task_run || (await cancelIfActive(runs, pending.task_run)) !== "failed";
		for (const sandboxId of pending.sandboxes) stopped = (await terminate(runs, sandboxId)) && stopped;
		if (stopped) {
			await db.withTx((tx) => append(tx, runEvent(runCleanedUp, runId, thread, { by }, by)));
			cleanup.confirmed.push(...resources);
		} else {
			cleanup.unconfirmed.push(...resources);
		}
	}
	return cleanup;
}

const ACTIVE_TASK_RUN = new Set(["pending", "running", "paused"]);

async function cancelIfActive(runs: RunControl, taskRunId: string): Promise<"stopped" | "inactive" | "failed"> {
	try {
		const { status } = await runs.getTaskRun(taskRunId);
		if (!ACTIVE_TASK_RUN.has(status)) return "inactive";
	} catch (error) {
		if (error instanceof ClientError && error.statusCode === 404) return "inactive";
		warn("could not read the task run; cancelling it anyway", error, { taskRunId });
	}
	try {
		await runs.cancelTaskRun(taskRunId);
		return "stopped";
	} catch (error) {
		warn("could not cancel the stopped run", error, { taskRunId });
		return "failed";
	}
}

async function terminate(runs: RunControl, sandboxId: string): Promise<boolean> {
	try {
		await runs.terminateSandbox(sandboxId);
		return true;
	} catch (error) {
		warn("could not terminate the stopped run's sandbox", error, { sandboxId });
		return false;
	}
}
