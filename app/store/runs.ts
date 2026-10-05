import { db } from "./pool.js";
import type { RunRecord, RunStatus, SubjectKind } from "./types.js";

export interface CreateRunInput {
	id: string;
	repo: string;
	subjectKind: SubjectKind;
	subjectNumber: number;
	workflow: string;
	trigger?: Record<string, unknown>;
	input?: Record<string, unknown>;
	previousRunId?: string;
}

/**
 * Insert a run in queued status. Returns false when the partial unique
 * index on (repo, subject_kind, subject_number) prevents it.
 */
export async function createQueuedRun(input: CreateRunInput): Promise<boolean> {
	const result = await db().query(
		`INSERT INTO runs (
		   id, repo, subject_kind, subject_number, workflow,
		   status, trigger, input, previous_run_id
		 )
		 VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8)
		 ON CONFLICT DO NOTHING`,
		[
			input.id,
			input.repo,
			input.subjectKind,
			input.subjectNumber,
			input.workflow,
			input.trigger ? JSON.stringify(input.trigger) : null,
			input.input ? JSON.stringify(input.input) : null,
			input.previousRunId ?? null,
		],
	);
	return result.rowCount === 1;
}

/**
 * Claim queued runs for dispatch. Uses FOR UPDATE SKIP LOCKED to avoid
 * double-claiming under concurrency.
 */
export async function claimForDispatch(
	limit = 10,
): Promise<Array<{ id: string; workflow: string }>> {
	const { rows } = await db().query(
		`UPDATE runs
		 SET status = 'dispatched',
		     dispatched_at = now(),
		     dispatch_attempts = dispatch_attempts + 1,
		     updated_at = now()
		 WHERE id IN (
		   SELECT id FROM runs
		   WHERE status = 'queued'
		     AND (dispatch_after IS NULL OR dispatch_after <= now())
		   ORDER BY created_at
		   FOR UPDATE SKIP LOCKED
		   LIMIT $1
		 )
		 RETURNING id, workflow`,
		[limit],
	);
	return rows.map((r: { id: string; workflow: string }) => ({
		id: r.id,
		workflow: r.workflow,
	}));
}

/**
 * Compare-and-set from queued or dispatched to running.
 * Returns true if this process won the claim.
 */
export async function markStarted(runId: string): Promise<boolean> {
	const result = await db().query(
		`UPDATE runs
		 SET status = 'running', started_at = now(), updated_at = now()
		 WHERE id = $1 AND status IN ('queued', 'dispatched')`,
		[runId],
	);
	return (result.rowCount ?? 0) === 1;
}

export async function heartbeat(runId: string): Promise<void> {
	await db().query(
		"UPDATE runs SET heartbeat_at = now(), updated_at = now() WHERE id = $1",
		[runId],
	);
}

export async function requestCancel(runId: string): Promise<boolean> {
	const result = await db().query(
		`UPDATE runs
		 SET cancel_requested_at = now(), updated_at = now()
		 WHERE id = $1
		   AND status IN ('queued', 'dispatched', 'running')
		   AND cancel_requested_at IS NULL`,
		[runId],
	);
	return (result.rowCount ?? 0) === 1;
}

export interface FinishRunResult {
	finished: boolean;
	followUpCreated: boolean;
}

/**
 * Finish a run only if it is still non-terminal. Uses COALESCE to
 * preserve existing outcome/summary when the caller omits them, and
 * merges result jsonb additively. Optionally creates a follow-up run
 * in the same transaction.
 */
export async function finishRun(
	runId: string,
	status: Extract<RunStatus, "completed" | "failed" | "cancelled">,
	details: {
		outcome?: string;
		result?: Record<string, unknown>;
		summary?: string;
		followUp?: CreateRunInput;
	} = {},
): Promise<FinishRunResult> {
	const client = await db().connect();
	try {
		await client.query("BEGIN");

		const upd = await client.query(
			`UPDATE runs
			 SET status = $2,
			     outcome = COALESCE($3, outcome),
			     result = COALESCE(result, '{}'::jsonb) || COALESCE($4::jsonb, '{}'::jsonb),
			     summary = COALESCE($5, summary),
			     completed_at = now(),
			     updated_at = now()
			 WHERE id = $1
			   AND status IN ('queued', 'dispatched', 'running')`,
			[
				runId,
				status,
				details.outcome ?? null,
				details.result ? JSON.stringify(details.result) : null,
				details.summary ?? null,
			],
		);

		const finished = (upd.rowCount ?? 0) === 1;
		let followUpCreated = false;

		if (finished && details.followUp) {
			const f = details.followUp;
			const ins = await client.query(
				`INSERT INTO runs (
				   id, repo, subject_kind, subject_number, workflow,
				   status, trigger, input, previous_run_id
				 )
				 VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8)
				 ON CONFLICT DO NOTHING`,
				[
					f.id,
					f.repo,
					f.subjectKind,
					f.subjectNumber,
					f.workflow,
					f.trigger ? JSON.stringify(f.trigger) : null,
					f.input ? JSON.stringify(f.input) : null,
					f.previousRunId ?? null,
				],
			);
			followUpCreated = (ins.rowCount ?? 0) === 1;
		}

		await client.query("COMMIT");
		return { finished, followUpCreated };
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

/** Merge a partial object into runs.result (jsonb). */
export async function mergeRunResult(
	runId: string,
	patch: Record<string, unknown>,
): Promise<void> {
	await db().query(
		`UPDATE runs
		 SET result = COALESCE(result, '{}'::jsonb) || $2::jsonb,
		     updated_at = now()
		 WHERE id = $1`,
		[runId, JSON.stringify(patch)],
	);
}

export async function setRunStage(runId: string, stage: string): Promise<void> {
	await db().query(
		"UPDATE runs SET stage = $2, updated_at = now() WHERE id = $1",
		[runId, stage],
	);
}

export async function getRun(id: string): Promise<RunRecord | null> {
	const { rows } = await db().query(
		`SELECT id, repo, subject_kind, subject_number, workflow,
		        status, stage, outcome, result, summary, trigger,
		        input, previous_run_id, cancel_requested_at,
		        dispatch_attempts, dispatch_after, dispatched_at,
		        heartbeat_at, started_at, completed_at,
		        cost_usd, created_at, updated_at
		 FROM runs WHERE id = $1`,
		[id],
	);
	if (rows.length === 0) return null;
	return mapRunRow(rows[0]);
}

function mapRunRow(row: Record<string, unknown>): RunRecord {
	return {
		id: row.id as string,
		repo: row.repo as string,
		subjectKind: row.subject_kind as SubjectKind,
		subjectNumber: row.subject_number as number,
		workflow: row.workflow as string,
		status: row.status as RunStatus,
		stage: (row.stage as string) ?? null,
		outcome: (row.outcome as string) ?? null,
		result: (row.result as Record<string, unknown>) ?? null,
		summary: (row.summary as string) ?? null,
		trigger: (row.trigger as Record<string, unknown>) ?? null,
		input: (row.input as Record<string, unknown>) ?? null,
		previousRunId: (row.previous_run_id as string) ?? null,
		cancelRequestedAt: row.cancel_requested_at
			? (row.cancel_requested_at as Date).toISOString()
			: null,
		dispatchAttempts: row.dispatch_attempts as number,
		dispatchAfter: row.dispatch_after
			? (row.dispatch_after as Date).toISOString()
			: null,
		dispatchedAt: row.dispatched_at
			? (row.dispatched_at as Date).toISOString()
			: null,
		heartbeatAt: row.heartbeat_at
			? (row.heartbeat_at as Date).toISOString()
			: null,
		startedAt: row.started_at ? (row.started_at as Date).toISOString() : null,
		completedAt: row.completed_at
			? (row.completed_at as Date).toISOString()
			: null,
		costUsd: Number(row.cost_usd ?? 0),
		createdAt: (row.created_at as Date).toISOString(),
		updatedAt: (row.updated_at as Date).toISOString(),
	};
}
