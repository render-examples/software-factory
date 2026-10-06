import { repository } from "../config/index.js";
import { reapSandboxes } from "./reap.js";
import { ensureSnapshot, pruneAllRetiredSnapshots } from "./snapshot.js";

/**
 * Run full workspace maintenance:
 * 1. Reap stale sandboxes.
 * 2. Ensure an up-to-date snapshot exists.
 * 3. Prune retired snapshots.
 *
 * Each step logs and continues on failure.
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
		await ensureSnapshot();
	} catch (err) {
		console.error(
			"Workspace maintenance: ensureSnapshot failed:",
			err instanceof Error ? err.message : err,
		);
	}

	try {
		const repoRef = repository();
		await pruneAllRetiredSnapshots(`${repoRef.owner}/${repoRef.repo}`);
	} catch (err) {
		console.error(
			"Workspace maintenance: prune retired snapshots failed:",
			err instanceof Error ? err.message : err,
		);
	}
}
