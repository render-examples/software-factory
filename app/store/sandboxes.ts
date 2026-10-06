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
}): Promise<void> {
	await db().query(
		`INSERT INTO sandboxes
		   (id, provider_id, status, base_sha, lockfile_hash, run_id, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		[
			input.id,
			input.providerId ?? null,
			input.status,
			input.baseSha ?? null,
			input.lockfileHash ?? null,
			input.runId ?? null,
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
		 SET status = 'warm', base_sha = $2, lockfile_hash = $3,
		     ready_at = now(), expires_at = $4
		 WHERE id = $1 AND status = 'preparing'`,
		[id, baseSha, lockfileHash, expiresAt],
	);
	return (result.rowCount ?? 0) === 1;
}

/**
 * Mark a preparing sandbox as ready and leased in one step.
 * Used by the cold path so a concurrent claimWarmSandbox cannot
 * steal the sandbox between warm and lease. Guards: only from 'preparing'.
 */
export async function markSandboxReadyAndLeased(
	id: string,
	runId: string,
	baseSha: string,
	lockfileHash: string,
	expiresAt: Date,
): Promise<boolean> {
	const result = await db().query(
		`UPDATE sandboxes
		 SET status = 'leased', run_id = $2, base_sha = $3,
		     lockfile_hash = $4, ready_at = now(), expires_at = $5,
		     leased_at = now()
		 WHERE id = $1 AND status = 'preparing'`,
		[id, runId, baseSha, lockfileHash, expiresAt],
	);
	return (result.rowCount ?? 0) === 1;
}

export async function markSandboxFailed(id: string): Promise<void> {
	await db().query(`UPDATE sandboxes SET status = 'failed' WHERE id = $1`, [
		id,
	]);
}

export async function markSandboxTerminated(id: string): Promise<void> {
	await db().query(
		`UPDATE sandboxes SET status = 'released', released_at = now()
		 WHERE id = $1 AND status NOT IN ('released', 'failed')`,
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
 * Count warm and recent in-flight sandboxes. In-flight rows
 * (creating/preparing) older than 30 minutes are excluded since
 * they are likely stuck.
 */
export async function countPoolSandboxes(): Promise<number> {
	const { rows } = await db().query(
		`SELECT count(*)::int AS cnt FROM sandboxes
		 WHERE status = 'warm'
		    OR (status IN ('creating', 'preparing')
		        AND created_at > now() - interval '30 minutes')`,
	);
	return rows[0].cnt;
}

/**
 * Atomically claim warm sandboxes eligible for recycling by
 * transitioning them from warm → released. Returns only the rows
 * this call transitioned, preventing TOCTOU races with lease claims.
 */
export async function claimRecyclableSandboxes(
	maxAgeMinutes: number,
	currentBaseSha: string,
): Promise<SandboxRecord[]> {
	const { rows } = await db().query(
		`UPDATE sandboxes
		 SET status = 'released', released_at = now()
		 WHERE id IN (
		   SELECT id FROM sandboxes
		   WHERE status = 'warm'
		     AND (
		       ready_at < now() - make_interval(mins => $1)
		       OR expires_at < now() + interval '30 minutes'
		       OR base_sha != $2
		     )
		   FOR UPDATE SKIP LOCKED
		 )
		 RETURNING id, provider_id, status, base_sha, lockfile_hash,
		           run_id, created_at, ready_at, expires_at,
		           leased_at, released_at`,
		[maxAgeMinutes, currentBaseSha],
	);
	return rows.map(mapSandboxRow);
}

/**
 * Atomically claim expired warm sandboxes by transitioning
 * warm → released, preventing TOCTOU races with lease claims.
 */
export async function claimExpiredWarmSandboxes(): Promise<SandboxRecord[]> {
	const { rows } = await db().query(
		`UPDATE sandboxes
		 SET status = 'released', released_at = now()
		 WHERE id IN (
		   SELECT id FROM sandboxes
		   WHERE status = 'warm'
		     AND expires_at < now()
		   FOR UPDATE SKIP LOCKED
		 )
		 RETURNING id, provider_id, status, base_sha, lockfile_hash,
		           run_id, created_at, ready_at, expires_at,
		           leased_at, released_at`,
	);
	return rows.map(mapSandboxRow);
}

/**
 * Leased sandboxes whose run is terminal. These are safe to
 * terminate because the run will not use them again.
 */
export async function listTerminalLeasedSandboxes(): Promise<SandboxRecord[]> {
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

/**
 * In-flight rows (creating/preparing) older than 30 minutes are
 * likely stuck after a crash. Returns them for termination.
 */
export async function listStuckInFlightSandboxes(): Promise<SandboxRecord[]> {
	const { rows } = await db().query(
		`SELECT id, provider_id, status, base_sha, lockfile_hash,
		        run_id, created_at, ready_at, expires_at,
		        leased_at, released_at
		 FROM sandboxes
		 WHERE status IN ('creating', 'preparing')
		   AND created_at < now() - interval '30 minutes'`,
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
