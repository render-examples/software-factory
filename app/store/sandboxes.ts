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
