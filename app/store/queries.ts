import { db } from "./pool.js";
import type {
	ArtifactRecord,
	DeliveryOutcome,
	DeliveryRecord,
	RunEventRecord,
	RunRecord,
	RunStatus,
	SubjectKind,
} from "./types.js";
import type { SpecVersionRecord } from "./specs.js";

export interface ListRunsFilter {
	workflow?: string;
	status?: RunStatus;
	subjectKind?: SubjectKind;
	subjectNumber?: number;
	before?: string;
	limit?: number;
}

/** List runs newest-first with optional filters and cursor. */
export async function listRuns(
	filter: ListRunsFilter = {},
): Promise<RunRecord[]> {
	const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
	const conditions: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (filter.workflow) {
		conditions.push(`workflow = $${idx++}`);
		params.push(filter.workflow);
	}
	if (filter.status) {
		conditions.push(`status = $${idx++}`);
		params.push(filter.status);
	}
	if (filter.subjectKind) {
		conditions.push(`subject_kind = $${idx++}`);
		params.push(filter.subjectKind);
	}
	if (filter.subjectNumber !== undefined) {
		conditions.push(`subject_number = $${idx++}`);
		params.push(filter.subjectNumber);
	}
	if (filter.before) {
		conditions.push(`created_at < $${idx++}`);
		params.push(filter.before);
	}

	const where =
		conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	params.push(limit);

	const { rows } = await db().query(
		`SELECT id, repo, subject_kind, subject_number, workflow,
		        status, stage, outcome, result, summary, trigger,
		        input, previous_run_id, cancel_requested_at,
		        dispatch_attempts, dispatch_after, dispatched_at,
		        heartbeat_at, started_at, completed_at,
		        cost_usd, created_at, updated_at
		 FROM runs ${where}
		 ORDER BY created_at DESC
		 LIMIT $${idx}`,
		params,
	);
	return rows.map(mapRunRow);
}

/**
 * Walk the conversation chain: follow previous_run_id backwards
 * from the given run, then find any runs that reference it as
 * previous_run_id going forward.
 */
export async function listConversation(runId: string): Promise<RunRecord[]> {
	const { rows } = await db().query(
		`WITH RECURSIVE chain AS (
		   SELECT id, previous_run_id, created_at
		   FROM runs WHERE id = $1
		   UNION ALL
		   SELECT r.id, r.previous_run_id, r.created_at
		   FROM runs r JOIN chain c ON r.id = c.previous_run_id
		 ),
		 forward AS (
		   SELECT id, previous_run_id, created_at
		   FROM runs WHERE id = $1
		   UNION ALL
		   SELECT r.id, r.previous_run_id, r.created_at
		   FROM runs r JOIN forward f ON r.previous_run_id = f.id
		 ),
		 all_ids AS (
		   SELECT id FROM chain
		   UNION
		   SELECT id FROM forward
		 )
		 SELECT r.id, r.repo, r.subject_kind, r.subject_number, r.workflow,
		        r.status, r.stage, r.outcome, r.result, r.summary, r.trigger,
		        r.input, r.previous_run_id, r.cancel_requested_at,
		        r.dispatch_attempts, r.dispatch_after, r.dispatched_at,
		        r.heartbeat_at, r.started_at, r.completed_at,
		        r.cost_usd, r.created_at, r.updated_at
		 FROM runs r JOIN all_ids a ON r.id = a.id
		 ORDER BY r.created_at`,
		[runId],
	);
	return rows.map(mapRunRow);
}

/** List artifact metadata for a run. Never returns bytes or link_token_hash. */
export async function listArtifactsByRun(
	runId: string,
): Promise<ArtifactRecord[]> {
	const { rows } = await db().query(
		`SELECT id, run_id, kind, content_type, size, sha256, created_at, expires_at
		 FROM artifacts WHERE run_id = $1 ORDER BY created_at`,
		[runId],
	);
	return rows.map((row: Record<string, unknown>) => ({
		id: row.id as string,
		runId: row.run_id as string,
		kind: row.kind as string,
		contentType: row.content_type as string,
		size: row.size as number,
		sha256: row.sha256 as string,
		linkTokenHash: null,
		createdAt: (row.created_at as Date).toISOString(),
		expiresAt: (row.expires_at as Date).toISOString(),
	}));
}

/** List recent deliveries newest-first. */
export async function listDeliveries(limit = 50): Promise<DeliveryRecord[]> {
	const cap = Math.min(Math.max(limit, 1), 200);
	const { rows } = await db().query(
		`SELECT delivery_id, event, action, outcome, detail, received_at
		 FROM deliveries ORDER BY received_at DESC LIMIT $1`,
		[cap],
	);
	return rows.map((row: Record<string, unknown>) => ({
		deliveryId: row.delivery_id as string,
		event: row.event as string,
		action: row.action as string,
		outcome: row.outcome as DeliveryOutcome,
		detail: (row.detail as Record<string, unknown>) ?? null,
		receivedAt: (row.received_at as Date).toISOString(),
	}));
}

/** List events for a run, ordered by id. */
export async function listEventsByRun(
	runId: string,
): Promise<RunEventRecord[]> {
	const { rows } = await db().query(
		`SELECT id, run_id, type, stage, span_id, parent_span_id, phase, payload, created_at
		 FROM run_events WHERE run_id = $1 ORDER BY id`,
		[runId],
	);
	return rows.map((row: Record<string, unknown>) => ({
		id: String(row.id),
		runId: row.run_id as string,
		type: row.type as string,
		stage: (row.stage as string) ?? null,
		spanId: (row.span_id as string) ?? null,
		parentSpanId: (row.parent_span_id as string) ?? null,
		phase: (row.phase as "start" | "end" | "point") ?? null,
		payload: (row.payload as Record<string, unknown>) ?? null,
		createdAt: (row.created_at as Date).toISOString(),
	}));
}

/** List all versions for a spec, ordered by version ascending. */
export async function listSpecVersions(
	specId: string,
): Promise<SpecVersionRecord[]> {
	const { rows } = await db().query(
		`SELECT spec_id, version, document, markdown, notes, last_comment_id,
		        run_id, created_at
		 FROM spec_versions WHERE spec_id = $1 ORDER BY version`,
		[specId],
	);
	return rows.map((row: Record<string, unknown>) => ({
		specId: row.spec_id as string,
		version: row.version as number,
		document: row.document as Record<string, unknown>,
		markdown: row.markdown as string,
		notes: (row.notes as Record<string, unknown>) ?? null,
		lastCommentId: (row.last_comment_id as string) ?? null,
		runId: (row.run_id as string) ?? null,
		createdAt: (row.created_at as Date).toISOString(),
	}));
}

/** Get a single artifact by id: metadata and bytes for serving. */
export async function getArtifactForServing(
	id: string,
): Promise<{ contentType: string; bytes: Buffer; expiresAt: string } | null> {
	const { rows } = await db().query(
		`SELECT content_type, bytes, expires_at
		 FROM artifacts WHERE id = $1 AND expires_at > now()`,
		[id],
	);
	if (rows.length === 0) return null;
	return {
		contentType: rows[0].content_type as string,
		bytes: rows[0].bytes as Buffer,
		expiresAt: (rows[0].expires_at as Date).toISOString(),
	};
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
