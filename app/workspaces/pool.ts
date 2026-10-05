import { factoryConfig } from "../../factory.config.js";
import { target, repository } from "../config/env.js";
import { githubToken } from "../github/auth.js";
import { GitHub } from "../github/client.js";
import { connectSandbox } from "../sandbox/index.js";
import {
	countSandboxesByStatus,
	listExpiredSandboxes,
	listRecyclableSandboxes,
	markSandboxTerminated,
} from "../store/sandboxes.js";
import { prepareSandbox } from "./prepare.js";

/**
 * Top-up the warm pool to `pool.size`, recycle stale sandboxes, and
 * prepare replacements. Counts both warm and in-flight (creating/preparing)
 * rows so concurrent runs do not over-provision.
 */
export async function maintainPool(): Promise<void> {
	const pool = factoryConfig.pool;
	const repo = target();
	const repoRef = repository();

	const gh = new GitHub(() =>
		githubToken({ permissions: { contents: "read" } }),
	);
	const currentBaseSha = await gh.getBranchTipSha(repoRef, repo.baseBranch);

	const recyclable = await listRecyclableSandboxes(
		pool.refreshAfterMinutes,
		currentBaseSha,
	);

	for (const record of recyclable) {
		try {
			if (record.providerId) {
				const sb = connectSandbox(record.providerId);
				await sb.terminate();
			}
		} catch (err) {
			console.error(
				`Failed to terminate recyclable sandbox ${record.id}:`,
				err instanceof Error ? err.message : err,
			);
		}
		await markSandboxTerminated(record.id);
	}

	const inFlight = await countSandboxesByStatus([
		"warm",
		"creating",
		"preparing",
	]);
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
 * Terminate leased sandboxes whose run is terminal and any recorded
 * sandbox past `expires_at`. Only touches sandboxes in the
 * `sandboxes` table.
 */
export async function reapSandboxes(): Promise<void> {
	const expired = await listExpiredSandboxes();
	for (const record of expired) {
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
		await markSandboxTerminated(record.id);
	}
}
