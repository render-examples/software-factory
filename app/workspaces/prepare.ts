import { createHash, randomUUID } from "node:crypto";
import { target } from "../config/env.js";
import { factoryConfig } from "../../factory.config.js";
import { createSandbox, type Sandbox } from "../sandbox/index.js";
import {
	markSandboxFailed,
	markSandboxPreparing,
	markSandboxReady,
	recordSandbox,
	setSandboxProviderId,
} from "../store/sandboxes.js";
import { shellEscape } from "../shell/index.js";
import { cloneWithReadToken } from "./credentials.js";

const LOCKFILE_NAMES = [
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
] as const;

/**
 * Compute the SHA-256 of whichever lockfile exists in the checkout.
 * Returns an empty-string hash when none is found.
 */
async function lockfileHash(sandbox: Sandbox, dir: string): Promise<string> {
	for (const name of LOCKFILE_NAMES) {
		const result = await sandbox.run(`cat ${shellEscape(`${dir}/${name}`)}`);
		if (result.exitCode === 0 && result.output.length > 0) {
			return createHash("sha256").update(result.output).digest("hex");
		}
	}
	return createHash("sha256").update("").digest("hex");
}

export interface PrepareResult {
	sandbox: Sandbox;
	sandboxRecordId: string;
	baseSha: string;
	lockfileHash: string;
}

/**
 * Create a sandbox, clone the base branch, run setup.install, and
 * optionally install Playwright browsers. Records the sandbox in
 * Postgres before calling the platform, filling in the provider ID
 * once created. On any failure the sandbox is terminated and the
 * row is marked failed.
 */
export async function prepareSandbox(): Promise<PrepareResult> {
	const repo = target();
	const pool = factoryConfig.pool;
	const recordId = randomUUID();

	await recordSandbox({
		id: recordId,
		status: "creating",
	});

	let sandbox: Sandbox;
	try {
		const networkPolicy =
			pool.network && Object.keys(pool.network).length > 0
				? (pool.network as {
						default: "allow-all" | "deny-all" | "allow-list";
						allowedDomains?: string[];
					})
				: undefined;
		sandbox = await createSandbox({
			timeoutSeconds: pool.sandboxTimeoutSeconds,
			...(networkPolicy ? { networkPolicy } : {}),
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
			await sandbox.mustRun(
				"npx playwright install chromium",
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
		const hash = await lockfileHash(sandbox, repo.repoDir);

		const expiresAt = new Date(Date.now() + pool.sandboxTimeoutSeconds * 1000);
		await markSandboxReady(recordId, baseSha, hash, expiresAt);

		return { sandbox, sandboxRecordId: recordId, baseSha, lockfileHash: hash };
	} catch (err) {
		await sandbox.terminate().catch(() => {});
		await markSandboxFailed(recordId);
		throw err;
	}
}
