import { randomUUID } from "node:crypto";
import { target } from "../config/index.js";
import { factoryConfig } from "../../factory.config.js";
import { createSandbox, type Sandbox } from "../sandbox/index.js";
import {
	markSandboxFailed,
	markSandboxPreparing,
	markSandboxReady,
	markSandboxReadyAndLeased,
	recordSandbox,
	setSandboxProviderId,
} from "../store/index.js";
import { shellEscape } from "../shell/index.js";
import { BROWSER_DIR, PLAYWRIGHT_VERSION } from "../tools/index.js";
import { cloneWithReadToken } from "./credentials.js";
import { lockfileHashInSandbox } from "./hash.js";

export interface PrepareResult {
	sandbox: Sandbox;
	sandboxRecordId: string;
	baseSha: string;
	lockfileHash: string;
}

export interface PrepareOpts {
	/** When set, mark the row leased to this run instead of warm. */
	leaseTo?: string;
}

/**
 * Create a sandbox, clone the base branch, run setup.install, and
 * optionally install Playwright browsers. Records the sandbox in
 * Postgres before calling the platform, filling in the provider ID
 * once created. On any failure the sandbox is terminated and the
 * row is marked failed.
 *
 * When `leaseTo` is set the row transitions directly from preparing
 * to leased, preventing a concurrent claimWarmSandbox from stealing
 * the sandbox.
 */
export async function prepareSandbox(
	opts?: PrepareOpts,
): Promise<PrepareResult> {
	const repo = target();
	const pool = factoryConfig.pool;
	const recordId = randomUUID();

	await recordSandbox({
		id: recordId,
		status: "creating",
		runId: opts?.leaseTo ?? undefined,
	});

	let sandbox: Sandbox;
	try {
		sandbox = await createSandbox({
			timeoutSeconds: pool.sandboxTimeoutSeconds,
			...(pool.network ? { networkPolicy: pool.network } : {}),
		});

		await setSandboxProviderId(recordId, sandbox.id);
		await markSandboxPreparing(recordId);
	} catch (err) {
		await markSandboxFailed(recordId);
		throw err;
	}

	try {
		await cloneWithReadToken(
			sandbox,
			{
				owner: repo.owner,
				repo: repo.name,
				branch: repo.baseBranch,
			},
			repo.repoDir,
		);

		await sandbox.mustRun(
			`cd ${shellEscape(repo.repoDir)} && ${repo.setup.install}`,
			"Install dependencies",
		);

		if (repo.setup.browsers) {
			const dir = shellEscape(BROWSER_DIR);
			await sandbox.mustRun(
				`mkdir -p ${dir} && cd ${dir} && npm init -y --silent && npm install ${shellEscape(`playwright-core@${PLAYWRIGHT_VERSION}`)} --silent`,
				"Install playwright-core for the browser driver",
			);
			await sandbox.mustRun(
				`cd ${dir} && ./node_modules/.bin/playwright-core install chromium`,
				"Install Playwright Chromium",
			);
		}

		const baseShaResult = await sandbox.run(
			`git -C ${shellEscape(repo.repoDir)} rev-parse HEAD`,
		);
		if (baseShaResult.exitCode !== 0) {
			throw new Error("Failed to determine base SHA");
		}
		const baseSha = baseShaResult.output.trim();
		const hash = await lockfileHashInSandbox(sandbox, repo.repoDir);

		const expiresAt = new Date(Date.now() + pool.sandboxTimeoutSeconds * 1000);

		if (opts?.leaseTo) {
			await markSandboxReadyAndLeased(
				recordId,
				opts.leaseTo,
				baseSha,
				hash,
				expiresAt,
			);
		} else {
			await markSandboxReady(recordId, baseSha, hash, expiresAt);
		}

		return { sandbox, sandboxRecordId: recordId, baseSha, lockfileHash: hash };
	} catch (err) {
		await sandbox.terminate().catch(() => {});
		await markSandboxFailed(recordId);
		throw err;
	}
}
