import { factoryConfig } from "../../factory.config.js";
import { target, repository } from "../config/index.js";
import { githubToken, GitHub } from "../github/index.js";
import { connectSandbox } from "../sandbox/index.js";
import {
	countPoolSandboxes,
	claimRecyclableSandboxes,
	claimExpiredWarmSandboxes,
	listTerminalLeasedSandboxes,
	listStuckInFlightSandboxes,
	markSandboxFailed,
	markSandboxTerminated,
} from "../store/index.js";
import { prepareSandbox } from "./prepare.js";

/**
 * Top-up the warm pool to `pool.size`, recycle stale sandboxes, and
 * prepare replacements. Recycle uses an atomic warm → released
 * transition so a concurrent lease cannot claim a sandbox that is
 * about to be terminated.
 */
export async function maintainPool(): Promise<void> {
	const pool = factoryConfig.pool;
	const repo = target();
	const repoRef = repository();

	const gh = new GitHub(() =>
		githubToken({ permissions: { contents: "read" } }),
	);
	const currentBaseSha = await gh.getBranchTipSha(repoRef, repo.baseBranch);

	const recycled = await claimRecyclableSandboxes(
		pool.refreshAfterMinutes,
		currentBaseSha,
	);

	for (const record of recycled) {
		try {
			if (record.providerId) {
				const sb = connectSandbox(record.providerId);
				await sb.terminate();
			}
		} catch (err) {
			console.error(
				`Failed to terminate recycled sandbox ${record.id}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	const inFlight = await countPoolSandboxes();
	const deficit = pool.size - inFlight;

	for (let i = 0; i < deficit; i++) {
		try {
			await prepareSandbox();
		} catch (err) {
			console.error(
				"Failed to prepare warm sandbox:",
				err instanceof Error ? err.message : err,
			);
		}
	}
}

/**
 * Terminate sandboxes that should no longer be running:
 * 1. Leased sandboxes whose run is terminal.
 * 2. Expired warm sandboxes (atomically claimed to prevent race).
 * 3. Stuck in-flight rows older than 30 minutes.
 *
 * Only touches sandboxes recorded in the `sandboxes` table.
 */
export async function reapSandboxes(): Promise<void> {
	const terminal = await listTerminalLeasedSandboxes();
	for (const record of terminal) {
		try {
			if (record.providerId) {
				const sb = connectSandbox(record.providerId);
				await sb.terminate();
			}
		} catch (err) {
			console.error(
				`Failed to terminate terminal sandbox ${record.id}:`,
				err instanceof Error ? err.message : err,
			);
		}
		await markSandboxTerminated(record.id);
	}

	const expiredWarm = await claimExpiredWarmSandboxes();
	for (const record of expiredWarm) {
		try {
			if (record.providerId) {
				const sb = connectSandbox(record.providerId);
				await sb.terminate();
			}
		} catch (err) {
			console.error(
				`Failed to terminate expired sandbox ${record.id}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	const stuck = await listStuckInFlightSandboxes();
	for (const record of stuck) {
		try {
			if (record.providerId) {
				const sb = connectSandbox(record.providerId);
				await sb.terminate();
			}
		} catch (err) {
			console.error(
				`Failed to terminate stuck sandbox ${record.id}:`,
				err instanceof Error ? err.message : err,
			);
		}
		await markSandboxFailed(record.id);
	}
}
