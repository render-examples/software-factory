import { db } from "./pool.js";

/**
 * Acquire a Postgres advisory lock, run `fn`, and release the lock.
 * The lock is session-level so it survives transaction boundaries.
 */
export async function withAdvisoryLock<T>(
	key: number,
	fn: () => Promise<T>,
): Promise<T> {
	const pool = db();
	const client = await pool.connect();
	try {
		await client.query(`SELECT pg_advisory_lock($1)`, [key]);
		try {
			return await fn();
		} finally {
			await client.query(`SELECT pg_advisory_unlock($1)`, [key]);
		}
	} finally {
		client.release();
	}
}
