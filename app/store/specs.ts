import { db } from "./pool.js";

export interface SpecRecord {
	id: string;
	repo: string;
	issueNumber: number;
	status: "draft" | "approved" | "superseded";
	currentVersion: number;
	approvedVersion: number | null;
	approvedBy: string | null;
	approvedAt: string | null;
	commentId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface SpecVersionRecord {
	specId: string;
	version: number;
	document: Record<string, unknown>;
	markdown: string;
	notes: Record<string, unknown> | null;
	lastCommentId: string | null;
	runId: string | null;
	createdAt: string;
}

export async function createSpec(input: {
	id: string;
	repo: string;
	issueNumber: number;
}): Promise<void> {
	await db().query(
		`INSERT INTO specs (id, repo, issue_number, status, current_version)
		 VALUES ($1, $2, $3, 'draft', 0)`,
		[input.id, input.repo, input.issueNumber],
	);
}

/**
 * Atomically increment current_version and insert the new spec_versions
 * row in one transaction. Returns the assigned version number.
 */
export async function addSpecVersion(input: {
	specId: string;
	document: Record<string, unknown>;
	markdown: string;
	notes?: Record<string, unknown>;
	lastCommentId?: string;
	runId?: string;
}): Promise<number> {
	const client = await db().connect();
	try {
		await client.query("BEGIN");

		const { rows } = await client.query(
			`UPDATE specs
			 SET current_version = current_version + 1,
			     updated_at = now()
			 WHERE id = $1
			 RETURNING current_version`,
			[input.specId],
		);
		const version: number = rows[0].current_version;

		await client.query(
			`INSERT INTO spec_versions
			   (spec_id, version, document, markdown,
			    notes, last_comment_id, run_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[
				input.specId,
				version,
				JSON.stringify(input.document),
				input.markdown,
				input.notes ? JSON.stringify(input.notes) : null,
				input.lastCommentId ?? null,
				input.runId ?? null,
			],
		);

		await client.query("COMMIT");
		return version;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

export async function getSpec(specId: string): Promise<SpecRecord | null> {
	const { rows } = await db().query(
		`SELECT id, repo, issue_number, status, current_version, approved_version,
		        approved_by, approved_at, comment_id, created_at, updated_at
		 FROM specs WHERE id = $1`,
		[specId],
	);
	if (rows.length === 0) return null;
	return mapSpecRow(rows[0]);
}

export async function getCurrentSpec(
	repo: string,
	issueNumber: number,
): Promise<SpecRecord | null> {
	const { rows } = await db().query(
		`SELECT id, repo, issue_number, status, current_version, approved_version,
		        approved_by, approved_at, comment_id, created_at, updated_at
		 FROM specs WHERE repo = $1 AND issue_number = $2 AND status != 'superseded'
		 ORDER BY created_at DESC LIMIT 1`,
		[repo, issueNumber],
	);
	if (rows.length === 0) return null;
	return mapSpecRow(rows[0]);
}

/**
 * Approve one existing version of a live spec. Returns false when the spec is
 * superseded or the version was never written, so a stale approval cannot bind.
 */
export async function approveVersion(
	specId: string,
	version: number,
	approvedBy: string,
): Promise<boolean> {
	const result = await db().query(
		`UPDATE specs SET status = 'approved', approved_version = $2, approved_by = $3,
		        approved_at = now(), updated_at = now()
		 WHERE id = $1 AND status != 'superseded'
		   AND EXISTS (
		     SELECT 1 FROM spec_versions WHERE spec_id = $1 AND version = $2
		   )`,
		[specId, version, approvedBy],
	);
	return (result.rowCount ?? 0) === 1;
}

export async function getSpecVersion(
	specId: string,
	version: number,
): Promise<SpecVersionRecord | null> {
	const { rows } = await db().query(
		`SELECT spec_id, version, document, markdown, notes, last_comment_id,
		        run_id, created_at
		 FROM spec_versions WHERE spec_id = $1 AND version = $2`,
		[specId, version],
	);
	if (rows.length === 0) return null;
	const row = rows[0];
	return {
		specId: row.spec_id,
		version: row.version,
		document: row.document,
		markdown: row.markdown,
		notes: row.notes ?? null,
		lastCommentId: row.last_comment_id ?? null,
		runId: row.run_id ?? null,
		createdAt: (row.created_at as Date).toISOString(),
	};
}

export async function setSpecCommentId(
	specId: string,
	commentId: string,
): Promise<void> {
	await db().query(
		"UPDATE specs SET comment_id = $2, updated_at = now() WHERE id = $1",
		[specId, commentId],
	);
}

export async function supersedeSpec(specId: string): Promise<void> {
	await db().query(
		"UPDATE specs SET status = 'superseded', updated_at = now() WHERE id = $1",
		[specId],
	);
}

function mapSpecRow(row: Record<string, unknown>): SpecRecord {
	return {
		id: row.id as string,
		repo: row.repo as string,
		issueNumber: row.issue_number as number,
		status: row.status as "draft" | "approved" | "superseded",
		currentVersion: row.current_version as number,
		approvedVersion: (row.approved_version as number) ?? null,
		approvedBy: (row.approved_by as string) ?? null,
		approvedAt: row.approved_at
			? (row.approved_at as Date).toISOString()
			: null,
		commentId: (row.comment_id as string) ?? null,
		createdAt: (row.created_at as Date).toISOString(),
		updatedAt: (row.updated_at as Date).toISOString(),
	};
}
