import { db } from "./pool.js";
import type { RunRecord, RunStatus } from "./types.js";

/**
 * Claim a run. Returns false when the delivery was already seen or another run
 * is still active for the issue.
 *
 * Both cases are enforced by unique constraints in app/sql, so two gateway
 * instances racing on the same webhook resolve correctly without a lock:
 * zero rows inserted means someone else already has it.
 */
export async function claimRun(input: {
	id: string;
	deliveryId: string;
	issueNumber: number;
}): Promise<boolean> {
	const result = await db().query(
		`insert into runs (id, delivery_id, issue_number)
		 values ($1, $2, $3)
		 on conflict do nothing`,
		[input.id, input.deliveryId, input.issueNumber],
	);
	return result.rowCount === 1;
}

/** Record the branch once the sandbox checkout exists. */
export async function setRunBranch(id: string, branch: string): Promise<void> {
	await db().query(
		"update runs set branch = $2, updated_at = now() where id = $1",
		[id, branch],
	);
}

/**
 * Close out a run. Moving off 'running' also releases the per-issue index,
 * which is what lets a maintainer retry by reapplying the label.
 */
export async function finishRun(
	id: string,
	status: Exclude<RunStatus, "running">,
	details: { pullRequest?: string; summary?: string } = {},
): Promise<void> {
	await db().query(
		`update runs
		 set status = $2, pull_request = $3, summary = $4, updated_at = now()
		 where id = $1`,
		[id, status, details.pullRequest ?? null, details.summary ?? null],
	);
}

export async function getRun(id: string): Promise<RunRecord | null> {
	const { rows } = await db().query(
		`select id, delivery_id, issue_number, status, branch, pull_request,
		        summary, created_at, updated_at
		 from runs where id = $1`,
		[id],
	);
	if (rows.length === 0) return null;

	const row = rows[0];
	return {
		id: row.id,
		deliveryId: row.delivery_id,
		issueNumber: row.issue_number,
		status: row.status,
		branch: row.branch,
		pullRequest: row.pull_request,
		summary: row.summary,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
	};
}
