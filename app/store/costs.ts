import { db } from "./pool.js";

/** Read the current accumulated cost for a run. */
export async function getRunCost(runId: string): Promise<number> {
	const { rows } = await db().query("SELECT cost_usd FROM runs WHERE id = $1", [
		runId,
	]);
	if (rows.length === 0) return 0;
	return Number(rows[0].cost_usd);
}

/** Atomically add USD to a run's cost_usd column. */
export async function addRunCost(runId: string, usd: number): Promise<void> {
	await db().query(
		"UPDATE runs SET cost_usd = cost_usd + $2, updated_at = now() WHERE id = $1",
		[runId, usd],
	);
}
