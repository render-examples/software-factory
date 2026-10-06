import { db } from "./pool.js";

export interface SnapshotRecord {
	id: string;
	sandboxGroupId: string;
	name: string;
	repo: string;
	baseSha: string;
	lockfileHash: string;
	buildKey: string;
	status: "available" | "retired";
	createdAt: string;
	expiresAt: string | null;
	retiredAt: string | null;
}

/** Return the current available snapshot for a repo, if one exists. */
export async function currentSnapshot(
	repo: string,
): Promise<SnapshotRecord | null> {
	const { rows } = await db().query(
		`SELECT id, sandbox_group_id, name, repo, base_sha, lockfile_hash,
		        build_key, status, created_at, expires_at, retired_at
		 FROM snapshots
		 WHERE repo = $1 AND status = 'available'
		 ORDER BY created_at DESC
		 LIMIT 1`,
		[repo],
	);
	if (rows.length === 0) return null;
	return mapSnapshotRow(rows[0]);
}

/** Record a new snapshot as available. */
export async function recordSnapshot(input: {
	id: string;
	sandboxGroupId: string;
	name: string;
	repo: string;
	baseSha: string;
	lockfileHash: string;
	buildKey: string;
	expiresAt?: Date;
}): Promise<void> {
	await db().query(
		`INSERT INTO snapshots
		   (id, sandbox_group_id, name, repo, base_sha, lockfile_hash,
		    build_key, status, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, 'available', $8)
		 ON CONFLICT (id) DO NOTHING`,
		[
			input.id,
			input.sandboxGroupId,
			input.name,
			input.repo,
			input.baseSha,
			input.lockfileHash,
			input.buildKey,
			input.expiresAt ?? null,
		],
	);
}

/** Retire all available snapshots for a repo except the given one. */
export async function retireOtherSnapshots(
	repo: string,
	keepId: string,
): Promise<string[]> {
	const { rows } = await db().query(
		`UPDATE snapshots
		 SET status = 'retired', retired_at = now()
		 WHERE repo = $1 AND status = 'available' AND id != $2
		 RETURNING id`,
		[repo, keepId],
	);
	return rows.map((r: { id: string }) => r.id);
}

/** Retire a single snapshot by ID. */
export async function retireSnapshot(id: string): Promise<void> {
	await db().query(
		`UPDATE snapshots SET status = 'retired', retired_at = now()
		 WHERE id = $1 AND status = 'available'`,
		[id],
	);
}

/** List all retired snapshots for a repo. */
export async function listRetiredSnapshots(
	repo: string,
): Promise<SnapshotRecord[]> {
	const { rows } = await db().query(
		`SELECT id, sandbox_group_id, name, repo, base_sha, lockfile_hash,
		        build_key, status, created_at, expires_at, retired_at
		 FROM snapshots
		 WHERE repo = $1 AND status = 'retired'
		 ORDER BY created_at`,
		[repo],
	);
	return rows.map(mapSnapshotRow);
}

/** Delete a snapshot row (after the provider snapshot has been deleted). */
export async function deleteSnapshotRecord(id: string): Promise<void> {
	await db().query(`DELETE FROM snapshots WHERE id = $1`, [id]);
}

/** List sandbox members belonging to a specific snapshot. */
export async function membersBySnapshot(
	snapshotId: string,
): Promise<Array<{ id: string; providerId: string | null; status: string }>> {
	const { rows } = await db().query(
		`SELECT id, provider_id, status
		 FROM sandboxes
		 WHERE snapshot_id = $1 AND role = 'member'`,
		[snapshotId],
	);
	return rows.map(
		(r: { id: string; provider_id: string | null; status: string }) => ({
			id: r.id,
			providerId: r.provider_id,
			status: r.status,
		}),
	);
}

function mapSnapshotRow(row: Record<string, unknown>): SnapshotRecord {
	return {
		id: row.id as string,
		sandboxGroupId: row.sandbox_group_id as string,
		name: row.name as string,
		repo: row.repo as string,
		baseSha: row.base_sha as string,
		lockfileHash: row.lockfile_hash as string,
		buildKey: row.build_key as string,
		status: row.status as "available" | "retired",
		createdAt: (row.created_at as Date).toISOString(),
		expiresAt: row.expires_at ? (row.expires_at as Date).toISOString() : null,
		retiredAt: row.retired_at ? (row.retired_at as Date).toISOString() : null,
	};
}
