import { db } from "../store/index.js";

/** Distinct from the migration lock key (1) to avoid contention. */
const MAINTENANCE_LOCK_KEY = 73491;

export interface MaintenanceStep {
	name: string;
	run: () => Promise<void>;
}

/**
 * Acquire a Postgres advisory lock, run each step in order, and release.
 * Each step's error is logged without stopping the others.
 */
export async function runMaintenance(steps: MaintenanceStep[]): Promise<void> {
	const pool = db();
	const client = await pool.connect();

	try {
		const { rows } = await client.query(
			`SELECT pg_try_advisory_lock(${MAINTENANCE_LOCK_KEY}) AS acquired`,
		);
		if (!rows[0].acquired) {
			console.log("maintenance: another instance holds the lock, exiting");
			return;
		}

		try {
			for (const step of steps) {
				try {
					await step.run();
				} catch (err) {
					console.error(`maintenance: step "${step.name}" failed:`, err);
				}
			}
		} finally {
			await client.query(`SELECT pg_advisory_unlock(${MAINTENANCE_LOCK_KEY})`);
		}
	} finally {
		client.release();
	}
}
