import { target } from "../config/index.js";
import { connectSandbox, type Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";
import {
	claimWarmSandbox,
	listSandboxesForRun,
	markSandboxFailed,
	markSandboxTerminated,
} from "../store/index.js";
import { fetchWithReadToken } from "./credentials.js";
import { lockfileHashInSandbox } from "./hash.js";
import { prepareSandbox } from "./prepare.js";

export type WorkspaceRef =
	| { kind: "branch"; name: string }
	| { kind: "pull"; number: number; headSha: string }
	| { kind: "sha"; sha: string };

export interface LeaseResult {
	sandbox: Sandbox;
	sandboxRecordId: string;
	repoDir: string;
	baseBranch: string;
	baseSha: string;
	headSha: string;
}

/**
 * Lease a sandbox for a run. Tries to claim a warm sandbox first;
 * if none available, prepares one from scratch (directly as leased).
 * Then fetches the requested ref, checks out the pinned SHA, and
 * reinstalls if the lockfile changed.
 *
 * baseSha semantics:
 * - branch: baseSha = headSha = the fetched tip
 * - pull:   baseSha = merge-base of base branch and headSha
 * - sha:    baseSha = sha
 */
export async function lease(
	runId: string,
	ref: WorkspaceRef,
): Promise<LeaseResult> {
	const repo = target();
	const repoDir = repo.repoDir;

	const result = await leaseWithWarmRetry(runId, ref, repo, repoDir);
	return result;
}

async function leaseWithWarmRetry(
	runId: string,
	ref: WorkspaceRef,
	repo: ReturnType<typeof target>,
	repoDir: string,
): Promise<LeaseResult> {
	const warm = await claimWarmSandbox(runId);
	if (warm) {
		if (!warm.providerId) {
			await markSandboxFailed(warm.id);
			return prepareColdAndLease(runId, ref, repo, repoDir);
		}
		const sandbox = connectSandbox(warm.providerId);
		try {
			return await setupRef(
				sandbox,
				warm.id,
				warm.lockfileHash ?? "",
				ref,
				repo,
				repoDir,
			);
		} catch (err) {
			await sandbox.terminate().catch(() => {});
			await markSandboxTerminated(warm.id);
			console.error(
				`Warm sandbox ${warm.id} failed, retrying with cold:`,
				err instanceof Error ? err.message : err,
			);
			return prepareColdAndLease(runId, ref, repo, repoDir);
		}
	}

	return prepareColdAndLease(runId, ref, repo, repoDir);
}

async function prepareColdAndLease(
	runId: string,
	ref: WorkspaceRef,
	repo: ReturnType<typeof target>,
	repoDir: string,
): Promise<LeaseResult> {
	const prepared = await prepareSandbox({ leaseTo: runId });
	try {
		return await setupRef(
			prepared.sandbox,
			prepared.sandboxRecordId,
			prepared.lockfileHash,
			ref,
			repo,
			repoDir,
		);
	} catch (err) {
		await prepared.sandbox.terminate().catch(() => {});
		await markSandboxTerminated(prepared.sandboxRecordId);
		throw err;
	}
}

async function setupRef(
	sandbox: Sandbox,
	sandboxRecordId: string,
	priorLockfileHash: string,
	ref: WorkspaceRef,
	repo: ReturnType<typeof target>,
	repoDir: string,
): Promise<LeaseResult> {
	let baseSha: string;
	let headSha: string;

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
		baseSha = headSha;

		await sandbox.mustRun(
			`git -C ${shellEscape(repoDir)} checkout ${shellEscape(headSha)}`,
			`Checkout branch ${ref.name}`,
		);
	} else if (ref.kind === "pull") {
		await fetchWithReadToken(sandbox, repoDir, `refs/pull/${ref.number}/head`, {
			owner: repo.owner,
			repo: repo.name,
		});
		await fetchWithReadToken(sandbox, repoDir, repo.baseBranch, {
			owner: repo.owner,
			repo: repo.name,
		});

		headSha = ref.headSha;
		await sandbox.mustRun(
			`git -C ${shellEscape(repoDir)} checkout ${shellEscape(headSha)}`,
			`Checkout PR #${ref.number} at ${headSha.slice(0, 8)}`,
		);

		const mergeBaseResult = await sandbox.run(
			`git -C ${shellEscape(repoDir)} merge-base ${shellEscape(`origin/${repo.baseBranch}`)} ${shellEscape(headSha)}`,
		);
		if (mergeBaseResult.exitCode !== 0) {
			throw new Error(`Failed to compute merge-base for PR #${ref.number}`);
		}
		baseSha = mergeBaseResult.output.trim();
	} else {
		headSha = ref.sha;
		baseSha = ref.sha;
		await fetchWithReadToken(sandbox, repoDir, ref.sha, {
			owner: repo.owner,
			repo: repo.name,
		});
		await sandbox.mustRun(
			`git -C ${shellEscape(repoDir)} checkout ${shellEscape(headSha)}`,
			`Checkout SHA ${headSha.slice(0, 8)}`,
		);
	}

	const newHash = await lockfileHashInSandbox(sandbox, repoDir);
	if (newHash !== priorLockfileHash) {
		await sandbox.mustRun(
			`cd ${shellEscape(repoDir)} && ${repo.setup.install}`,
			"Reinstall dependencies (lockfile changed)",
		);
	}

	return {
		sandbox,
		sandboxRecordId,
		repoDir,
		baseBranch: repo.baseBranch,
		baseSha,
		headSha,
	};
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
