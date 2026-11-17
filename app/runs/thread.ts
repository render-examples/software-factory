import { ClientError, Render } from "@renderinc/sdk";
import type { z } from "zod";
import { append, type Db, type NewEvent, type Queryable, VersionConflict } from "../db/index.js";
import { type EventSpec, runStarted, runStopped } from "../events/index.js";
import { sandboxClient } from "../sandbox/index.js";
import type { ThreadKey } from "../threads/index.js";
import { warn } from "./status.js";

/** The Render calls that stop a displaced run, injectable for tests. */
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

export type StartingRun = Omit<z.input<typeof runStarted.payload>, "run_id" | "trace_id"> & { thread: ThreadKey; runId: string; traceId: string };

const START_ATTEMPTS = 4;

/**
 * Appends the run's `run.started` to the thread's stream at the version it read, so of two runs that read the same
 * latest trace only one appends; the other rereads and tries again. A child run (`continue`) starts only while its
 * own trace is the thread's latest. Returns the trace the run displaced, or null when it may not start.
 */
export async function startOnThread(db: Db, run: StartingRun): Promise<{ displaced: string | null } | null> {
	const { thread, runId, traceId, ...started } = run;
	for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
		try {
			return await db.withTx(async (tx) => {
				const { rows } = await tx.query<{ traceId: string | null; version: number }>(
					`select (select trace_id from threads where thread = $1) as "traceId",
					   (select coalesce(max(stream_version), 0) from events where stream = $2) as version`,
					[thread, `thread:${thread}`],
				);
				const latest = rows[0] ?? { traceId: null, version: 0 };
				if (run.mode === "continue" && latest.traceId !== traceId) return null;
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
	// Newer runs started on every attempt.
	return null;
}

/** Whether the run is still running and its trace is the thread's latest. */
export async function isCurrent(db: Queryable, thread: ThreadKey, run: { traceId: string; runId: string }): Promise<boolean> {
	const { rows } = await db.query(
		"select 1 from threads t join runs r on r.run_id = $3 where t.thread = $1 and t.trace_id = $2 and r.state = 'running'",
		[thread, run.traceId, run.runId],
	);
	return rows.length > 0;
}

/**
 * Stops a displaced trace: cancels its root run if Render still has it active, terminates the Sandboxes its running
 * task runs recorded, and records those runs stopped. Render kills a cancelled task without running its `finally`,
 * so its Sandbox would otherwise live until its timeout and its runs would stay `running`. Returns the task runs
 * that were still running.
 */
export async function stopTrace(db: Db, runs: RunControl, traceId: string, stop: { by: string; summary: string }): Promise<string[]> {
	const { rows } = await db.query<{ runId: string; thread: ThreadKey; sandboxId: string | null }>(
		`select run_id as "runId", thread, sandbox_id as "sandboxId" from runs where trace_id = $1 and state = 'running'`,
		[traceId],
	);
	if (!rows.length) return [];
	const active = await cancelIfActive(runs, traceId);
	for (const { sandboxId } of rows) {
		if (sandboxId)
			await runs.terminateSandbox(sandboxId).catch((error) => warn("could not terminate the stopped run's sandbox", error, { sandboxId }));
	}
	const payload = { ...stop, active };
	await db.withTx(async (tx) => {
		for (const row of rows) await append(tx, runEvent(runStopped, row.runId, row.thread, payload, stop.by));
	});
	return rows.map((row) => row.runId);
}

/**
 * Cancels a task run that Render has pending or running, and returns whether it did. An unknown state counts as
 * active. A failed cancel is logged: the run is already fenced and stops at its next ownership check.
 */
async function cancelIfActive(runs: RunControl, taskRunId: string): Promise<boolean> {
	try {
		const { status } = await runs.getTaskRun(taskRunId);
		if (status !== "pending" && status !== "running") return false;
	} catch (error) {
		if (error instanceof ClientError && error.statusCode === 404) return false;
		warn("could not read the task run; cancelling it anyway", error, { taskRunId });
	}
	await runs.cancelTaskRun(taskRunId).catch((error) => warn("could not cancel the stopped run", error, { taskRunId }));
	return true;
}
