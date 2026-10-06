import { db } from "./pool.js";
import type { SandboxRecord } from "./types.js";

export async function recordSandbox(input: {
	id: string;
	providerId?: string;
	status: string;
	baseSha?: string;
	lockfileHash?: string;
	runId?: string;
	expiresAt?: Date;
	role?: string;
	snapshotId?: string;
}): Promise<void> {
	await db().query(
		`INSERT INTO sandboxes
		   (id, provider_id, status, base_sha, lockfile_hash, run_id,
		    expires_at, role, snapshot_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		[
			input.id,
			input.providerId ?? null,
			input.status,
			input.baseSha ?? null,
			input.lockfileHash ?? null,
			input.runId ?? null,
			input.expiresAt ?? null,
			input.role ?? null,
			input.snapshotId ?? null,
		],
	);
}

export async function markSandboxFailed(id: string): Promise<void> {
	await db().query(`UPDATE sandboxes SET status = 'failed' WHERE id = $1`, [
		id,
	]);
}

export async function markSandboxTerminated(id: string): Promise<void> {
	await db().query(
		`UPDATE sandboxes SET status = 'terminated', terminated_at = now()
		 WHERE id = $1 AND status NOT IN ('terminated', 'failed')`,
		[id],
	);
}

/** Update the provider_id after sandbox creation completes. */
export async function setSandboxProviderId(
	id: string,
	providerId: string,
): Promise<void> {
	await db().query(`UPDATE sandboxes SET provider_id = $2 WHERE id = $1`, [
		id,
		providerId,
	]);
}

/**
 * Transition from creating to preparing. Guards: only from 'creating'.
 * Returns whether it applied.
 */
export async function markSandboxPreparing(id: string): Promise<boolean> {
	const result = await db().query(
		`UPDATE sandboxes SET status = 'preparing'
		 WHERE id = $1 AND status = 'creating'`,
		[id],
	);
	return (result.rowCount ?? 0) === 1;
}

/**
 * Mark a preparing sandbox as ready. Guards: only from 'preparing'.
 * Returns whether the transition applied.
 */
export async function markSandboxReady(
	id: string,
	baseSha: string,
	lockfileHash: string,
	expiresAt: Date,
): Promise<boolean> {
	const result = await db().query(
		`UPDATE sandboxes
		 SET status = 'ready', base_sha = $2, lockfile_hash = $3,
		     ready_at = now(), expires_at = $4
		 WHERE id = $1 AND status = 'preparing'`,
		[id, baseSha, lockfileHash, expiresAt],
	);
	return (result.rowCount ?? 0) === 1;
}

/** All non-terminal sandboxes for a given run. */
export async function listSandboxesForRun(
	runId: string,
): Promise<SandboxRecord[]> {
	const { rows } = await db().query(
		`SELECT id, provider_id, status, base_sha, lockfile_hash,
		        run_id, created_at, ready_at, expires_at,
		        terminated_at
		 FROM sandboxes
		 WHERE run_id = $1 AND status NOT IN ('terminated', 'failed')`,
		[runId],
	);
	return rows.map(mapSandboxRow);
}

/**
 * List all sandboxes eligible for reaping:
 * - run sandboxes whose run is terminal
 * - any row past expires_at
 * - creating rows (non-builder) older than 30 minutes
 * - builder rows older than the builder timeout
 */
export async function listReapableSandboxes(
	builderTimeoutSeconds: number,
): Promise<SandboxRecord[]> {
	const { rows } = await db().query(
		`SELECT s.id, s.provider_id, s.status, s.base_sha,
		        s.lockfile_hash, s.run_id, s.created_at, s.ready_at,
		        s.expires_at, s.terminated_at
		 FROM sandboxes s
		 LEFT JOIN runs r ON r.id = s.run_id
		 WHERE s.status NOT IN ('terminated', 'failed')
		   AND (
		     (s.run_id IS NOT NULL AND r.status IN ('completed', 'failed', 'cancelled'))
		     OR (s.expires_at IS NOT NULL AND s.expires_at < now())
		     OR (s.status = 'creating' AND (s.role IS NULL OR s.role != 'builder')
		         AND s.created_at < now() - interval '30 minutes')
		     OR (s.role = 'builder' AND s.status IN ('creating', 'preparing')
		         AND s.created_at < now() - make_interval(secs => $1))
		   )`,
		[builderTimeoutSeconds],
	);
	return rows.map(mapSandboxRow);
}

function mapSandboxRow(row: Record<string, unknown>): SandboxRecord {
	return {
		id: row.id as string,
		providerId: (row.provider_id as string) ?? null,
		status: row.status as string,
		baseSha: (row.base_sha as string) ?? null,
		lockfileHash: (row.lockfile_hash as string) ?? null,
		runId: (row.run_id as string) ?? null,
		createdAt: (row.created_at as Date).toISOString(),
		readyAt: row.ready_at ? (row.ready_at as Date).toISOString() : null,
		expiresAt: row.expires_at ? (row.expires_at as Date).toISOString() : null,
		terminatedAt: row.terminated_at
			? (row.terminated_at as Date).toISOString()
			: null,
	};
}
