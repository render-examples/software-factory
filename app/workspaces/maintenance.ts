import { reapSandboxes, maintainPool } from "./pool.js";

/**
 * Run full workspace maintenance: reap first, then top-up/recycle.
 * Logs per-step errors without throwing so the caller can continue.
 */
export async function runWorkspaceMaintenance(): Promise<void> {
	try {
		await reapSandboxes();
	} catch (err) {
		console.error(
			"Workspace maintenance: reap failed:",
			err instanceof Error ? err.message : err,
		);
	}

	try {
		await maintainPool();
	} catch (err) {
		console.error(
			"Workspace maintenance: pool top-up failed:",
			err instanceof Error ? err.message : err,
		);
	}
}
