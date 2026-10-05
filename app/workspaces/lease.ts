import { createHash } from "node:crypto";
import { target } from "../config/env.js";
import { connectSandbox, type Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";
import {
	claimWarmSandbox,
	leaseSandbox,
	listSandboxesForRun,
	markSandboxTerminated,
} from "../store/sandboxes.js";
import { fetchWithReadToken } from "./credentials.js";
import { prepareSandbox } from "./prepare.js";

export type WorkspaceRef =
	| { kind: "branch"; name: string }
	| { kind: "pull"; number: number; headSha: string }
	| { kind: "sha"; sha: string };

export interface LeaseResult {
	sandbox: Sandbox;
	sandboxRecordId: string;
	repoDir: string;
	baseSha: string;
	headSha: string;
}

const LOCKFILE_NAMES = [
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
] as const;

async function currentLockfileHash(
	sandbox: Sandbox,
	dir: string,
): Promise<string> {
	for (const name of LOCKFILE_NAMES) {
		const result = await sandbox.run(`cat ${shellEscape(`${dir}/${name}`)}`);
		if (result.exitCode === 0 && result.output.length > 0) {
			return createHash("sha256").update(result.output).digest("hex");
		}
	}
	return createHash("sha256").update("").digest("hex");
}

/**
 * Lease a sandbox for a run. Tries to claim a warm sandbox first;
 * if none available, prepares one from scratch. Then fetches the
 * requested ref, checks out the pinned SHA, and reinstalls if
 * the lockfile changed.
 */
export async function lease(
	runId: string,
	ref: WorkspaceRef,
): Promise<LeaseResult> {
	const repo = target();
	const repoDir = repo.repoDir;

	let sandbox: Sandbox;
	let sandboxRecordId: string;
	let priorLockfileHash: string;
	let baseSha: string;

	const warm = await claimWarmSandbox(runId);
	if (warm) {
		if (!warm.providerId) {
			throw new Error(`Warm sandbox ${warm.id} has no provider ID`);
		}
		sandbox = connectSandbox(warm.providerId);
		sandboxRecordId = warm.id;
		priorLockfileHash = warm.lockfileHash ?? "";
		baseSha = warm.baseSha ?? "";
	} else {
		const prepared = await prepareSandbox();
		sandbox = prepared.sandbox;
		sandboxRecordId = prepared.sandboxRecordId;
		priorLockfileHash = prepared.lockfileHash;
		baseSha = prepared.baseSha;
		await leaseSandbox(sandboxRecordId, runId);
	}

	let headSha: string;

	try {
		if (ref.kind === "branch") {
			await fetchWithReadToken(sandbox, repoDir, ref.name, {
				owner: repo.owner,
				repo: repo.name,
			});

			const shaResult = await sandbox.run(
				`git -C ${shellEscape(repoDir)} rev-parse ${shellEscape(`origin/${ref.name}`)}`,
			);
			if (shaResult.exitCode !== 0) {
				throw new Error(`Failed to resolve branch ${ref.name}`);
			}
			headSha = shaResult.output.trim();

			await sandbox.mustRun(
				`git -C ${shellEscape(repoDir)} checkout ${shellEscape(headSha)}`,
				`Checkout branch ${ref.name}`,
			);
		} else if (ref.kind === "pull") {
			await fetchWithReadToken(
				sandbox,
				repoDir,
				`refs/pull/${ref.number}/head`,
				{ owner: repo.owner, repo: repo.name },
			);

			headSha = ref.headSha;
			await sandbox.mustRun(
				`git -C ${shellEscape(repoDir)} checkout ${shellEscape(headSha)}`,
				`Checkout PR #${ref.number} at ${headSha.slice(0, 8)}`,
			);
		} else {
			headSha = ref.sha;
			await fetchWithReadToken(sandbox, repoDir, ref.sha, {
				owner: repo.owner,
				repo: repo.name,
			});
			await sandbox.mustRun(
				`git -C ${shellEscape(repoDir)} checkout ${shellEscape(headSha)}`,
				`Checkout SHA ${headSha.slice(0, 8)}`,
			);
		}

		const newHash = await currentLockfileHash(sandbox, repoDir);
		if (newHash !== priorLockfileHash) {
			await sandbox.mustRun(
				`cd ${shellEscape(repoDir)} && ${repo.setup.install}`,
				"Reinstall dependencies (lockfile changed)",
			);
		}
	} catch (err) {
		await sandbox.terminate().catch(() => {});
		await markSandboxTerminated(sandboxRecordId);
		throw err;
	}

	return { sandbox, sandboxRecordId, repoDir, baseSha, headSha };
}

/**
 * Release every sandbox leased to a run. Terminates them on the
 * platform and marks them released. Idempotent: termination errors
 * are logged but the row is still marked.
 */
export async function release(runId: string): Promise<void> {
	const sandboxes = await listSandboxesForRun(runId);
	for (const record of sandboxes) {
		try {
			if (!record.providerId) continue;
			const sb = connectSandbox(record.providerId);
			await sb.terminate();
		} catch (err) {
			console.error(
				`Failed to terminate sandbox ${record.id} for run ${runId}:`,
				err instanceof Error ? err.message : err,
			);
		}
		await markSandboxTerminated(record.id);
	}
}
