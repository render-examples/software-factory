import { db } from "./pool.js";
import type { SandboxRecord } from "./types.js";

export async function recordSandbox(input: {
	id: string;
	providerId?: string;
	status: string;
	baseSha?: string;
	lockfileHash?: string;
	expiresAt?: Date;
}): Promise<void> {
	await db().query(
		`INSERT INTO sandboxes
		   (id, provider_id, status, base_sha, lockfile_hash, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		[
			input.id,
			input.providerId ?? null,
			input.status,
			input.baseSha ?? null,
			input.lockfileHash ?? null,
			input.expiresAt ?? null,
		],
	);
}

/**
 * Claim a warm sandbox using FOR UPDATE SKIP LOCKED. Skips sandboxes
 * that expire within `minRemainingSeconds` (default 1800 = 30 min).
 */
export async function claimWarmSandbox(
	runId: string,
	minRemainingSeconds = 1800,
): Promise<SandboxRecord | null> {
	const { rows } = await db().query(
		`UPDATE sandboxes
		 SET status = 'leased', run_id = $1, leased_at = now()
		 WHERE id = (
		   SELECT id FROM sandboxes
		   WHERE status = 'warm'
		     AND (expires_at IS NULL
		          OR expires_at > now() + make_interval(secs => $2))
		   ORDER BY ready_at
		   FOR UPDATE SKIP LOCKED
		   LIMIT 1
		 )
		 RETURNING id, provider_id, status, base_sha, lockfile_hash,
		           run_id, created_at, ready_at, expires_at,
		           leased_at, released_at`,
		[runId, minRemainingSeconds],
	);
	if (rows.length === 0) return null;
	return mapSandboxRow(rows[0]);
}

export async function leaseSandbox(id: string, runId: string): Promise<void> {
	await db().query(
		`UPDATE sandboxes
		 SET status = 'leased', run_id = $1, leased_at = now()
		 WHERE id = $2`,
		[runId, id],
	);
}

export async function releaseSandbox(id: string): Promise<void> {
	await db().query(
		`UPDATE sandboxes
		 SET status = 'released', released_at = now()
		 WHERE id = $1`,
		[id],
	);
}

export async function listStaleLeases(): Promise<SandboxRecord[]> {
	const { rows } = await db().query(
		`SELECT s.id, s.provider_id, s.status, s.base_sha,
		        s.lockfile_hash, s.run_id, s.created_at, s.ready_at,
		        s.expires_at, s.leased_at, s.released_at
		 FROM sandboxes s
		 JOIN runs r ON r.id = s.run_id
		 WHERE s.status = 'leased'
		   AND r.status IN ('completed', 'failed', 'cancelled')`,
	);
	return rows.map(mapSandboxRow);
}

/** Mark a sandbox as ready with its base SHA and lockfile hash. */
export async function markSandboxReady(
	id: string,
	baseSha: string,
	lockfileHash: string,
	expiresAt: Date,
): Promise<void> {
	await db().query(
		`UPDATE sandboxes
		 SET status = 'warm', base_sha = $2, lockfile_hash = $3,
		     ready_at = now(), expires_at = $4
		 WHERE id = $1`,
		[id, baseSha, lockfileHash, expiresAt],
	);
}

export async function markSandboxFailed(id: string): Promise<void> {
	await db().query(`UPDATE sandboxes SET status = 'failed' WHERE id = $1`, [
		id,
	]);
}

export async function markSandboxTerminated(id: string): Promise<void> {
	await db().query(
		`UPDATE sandboxes SET status = 'released', released_at = now()
		 WHERE id = $1`,
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

/** Update status from creating to preparing. */
export async function markSandboxPreparing(id: string): Promise<void> {
	await db().query(`UPDATE sandboxes SET status = 'preparing' WHERE id = $1`, [
		id,
	]);
}

/**
 * Count sandboxes by status. Used by pool maintenance to decide how
 * many new sandboxes to create.
 */
export async function countSandboxesByStatus(
	statuses: readonly string[],
): Promise<number> {
	const { rows } = await db().query(
		`SELECT count(*)::int AS cnt FROM sandboxes
		 WHERE status = ANY($1)`,
		[statuses],
	);
	return rows[0].cnt;
}

/**
 * Warm sandboxes eligible for recycling: older than `maxAgeMinutes`,
 * expiring within 30 minutes, or whose base_sha differs from the
 * current tip.
 */
export async function listRecyclableSandboxes(
	maxAgeMinutes: number,
	currentBaseSha: string,
): Promise<SandboxRecord[]> {
	const { rows } = await db().query(
		`SELECT id, provider_id, status, base_sha, lockfile_hash,
		        run_id, created_at, ready_at, expires_at,
		        leased_at, released_at
		 FROM sandboxes
		 WHERE status = 'warm'
		   AND (
		     ready_at < now() - make_interval(mins => $1)
		     OR expires_at < now() + interval '30 minutes'
		     OR base_sha != $2
		   )`,
		[maxAgeMinutes, currentBaseSha],
	);
	return rows.map(mapSandboxRow);
}

/**
 * Sandboxes past their expiry time OR leased to terminal runs.
 * Only returns sandboxes that are recorded in this table.
 */
export async function listExpiredSandboxes(): Promise<SandboxRecord[]> {
	const { rows } = await db().query(
		`SELECT id, provider_id, status, base_sha, lockfile_hash,
		        run_id, created_at, ready_at, expires_at,
		        leased_at, released_at
		 FROM sandboxes
		 WHERE (status NOT IN ('released', 'failed') AND expires_at < now())
		    OR (status = 'leased' AND run_id IS NOT NULL AND EXISTS (
		          SELECT 1 FROM runs r
		          WHERE r.id = sandboxes.run_id
		            AND r.status IN ('completed', 'failed', 'cancelled')
		        ))`,
	);
	return rows.map(mapSandboxRow);
}

/** All sandboxes leased to a given run. */
export async function listSandboxesForRun(
	runId: string,
): Promise<SandboxRecord[]> {
	const { rows } = await db().query(
		`SELECT id, provider_id, status, base_sha, lockfile_hash,
		        run_id, created_at, ready_at, expires_at,
		        leased_at, released_at
		 FROM sandboxes
		 WHERE run_id = $1 AND status = 'leased'`,
		[runId],
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
		leasedAt: row.leased_at ? (row.leased_at as Date).toISOString() : null,
		releasedAt: row.released_at
			? (row.released_at as Date).toISOString()
			: null,
	};
}
