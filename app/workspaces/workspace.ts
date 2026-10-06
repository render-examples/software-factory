import { randomUUID } from "node:crypto";
import { target } from "../config/index.js";
import {
	createSandbox,
	connectSandbox,
	SandboxSnapshotNotFoundError,
	type CreateSandboxResult,
} from "../sandbox/index.js";
import type { Sandbox, SandboxNetworkPolicy } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";
import {
	listSandboxesForRun,
	markSandboxFailed,
	markSandboxTerminated,
	markSandboxReady,
	recordSandbox,
	setSandboxProviderId,
	markSandboxPreparing,
	retireSnapshot,
} from "../store/index.js";
import { factoryConfig } from "../../factory.config.js";
import { fetchWithReadToken, verifyNoCredentialLeak } from "./credentials.js";
import { lockfileHashInSandbox } from "./hash.js";
import { ensureSnapshot } from "./snapshot.js";

export type WorkspaceRef =
	| { kind: "branch"; name: string }
	| { kind: "pull"; number: number; headSha: string }
	| { kind: "sha"; sha: string };

export interface Workspace {
	sandbox: Sandbox;
	sandboxRecordId: string;
	repoDir: string;
	baseBranch: string;
	baseSha: string;
	headSha: string;
}

const MANIFEST_PATH = "/home/user/.factory/manifest.json";

/** Network policy severity ordering for the wider-policy check. */
const POLICY_ORDER: Record<string, number> = {
	"deny-all": 0,
	"allow-list": 1,
	"allow-all": 2,
};

function isPolicyWider(returned: string, requested: string): boolean {
	return (POLICY_ORDER[returned] ?? 2) > (POLICY_ORDER[requested] ?? 0);
}

/**
 * Create a sandbox for a run from the current repository snapshot,
 * verify it, fetch the requested ref, and mark it ready.
 */
export async function openWorkspace(
	runId: string,
	ref: WorkspaceRef,
): Promise<Workspace> {
	return openWithRetry(runId, ref, false);
}

async function openWithRetry(
	runId: string,
	ref: WorkspaceRef,
	retried: boolean,
): Promise<Workspace> {
	const repo = target();
	const repoDir = repo.repoDir;
	const sandboxConfig = factoryConfig.sandbox;

	const { snapshot } = await ensureSnapshot();
	const recordId = randomUUID();

	await recordSandbox({
		id: recordId,
		status: "creating",
		runId,
		role: "run",
		snapshotId: snapshot.id,
	});

	let sandbox: Sandbox;
	let networkPolicy: SandboxNetworkPolicy | undefined;
	try {
		const result: CreateSandboxResult = await createSandbox({
			snapshotId: snapshot.id,
			timeoutSeconds: sandboxConfig.timeoutSeconds,
			...(sandboxConfig.network
				? { networkPolicy: sandboxConfig.network }
				: {}),
		});
		sandbox = result.sandbox;
		networkPolicy = result.networkPolicy;
		await setSandboxProviderId(recordId, sandbox.id);
		await markSandboxPreparing(recordId);
	} catch (err) {
		await markSandboxFailed(recordId);

		// The snapshot can expire or be pruned between ensureSnapshot and create.
		if (!retried && err instanceof SandboxSnapshotNotFoundError) {
			await retireSnapshot(snapshot.id);
			return openWithRetry(runId, ref, true);
		}
		throw err;
	}

	try {
		if (sandboxConfig.network && networkPolicy) {
			if (isPolicyWider(networkPolicy.default, sandboxConfig.network.default)) {
				throw new Error(
					`Sandbox ${sandbox.id} has wider policy ${networkPolicy.default} ` +
						`than requested ${sandboxConfig.network.default}; refused`,
				);
			}
		}

		let manifestRaw: string;
		try {
			manifestRaw = await sandbox.mustRun(
				`cat ${shellEscape(MANIFEST_PATH)}`,
				"Read manifest for verification",
			);
		} catch {
			throw new Error(
				`Sandbox ${sandbox.id}: manifest not found at ${MANIFEST_PATH}`,
			);
		}

		let manifest: { baseSha?: string; buildKey?: string };
		try {
			manifest = JSON.parse(manifestRaw);
		} catch {
			throw new Error(`Sandbox ${sandbox.id}: manifest is not valid JSON`);
		}

		if (manifest.baseSha !== snapshot.baseSha) {
			throw new Error(
				`Sandbox ${sandbox.id}: manifest baseSha ${manifest.baseSha} does not match snapshot ${snapshot.baseSha}`,
			);
		}
		if (manifest.buildKey !== snapshot.buildKey) {
			throw new Error(`Sandbox ${sandbox.id}: manifest buildKey mismatch`);
		}

		const headResult = await sandbox.run(
			`git -C ${shellEscape(repoDir)} rev-parse HEAD`,
		);
		if (
			headResult.exitCode !== 0 ||
			headResult.output.trim() !== snapshot.baseSha
		) {
			throw new Error(
				`Sandbox ${sandbox.id}: HEAD ${headResult.output.trim()} does not match expected ${snapshot.baseSha}`,
			);
		}

		await verifyNoCredentialLeak(sandbox, repoDir, repo.owner, repo.name);

		const refs = await fetchAndCheckout(sandbox, ref, repo, repoDir);

		const newHash = await lockfileHashInSandbox(sandbox, repoDir);
		if (newHash !== (snapshot.lockfileHash ?? "")) {
			await sandbox.mustRun(
				`cd ${shellEscape(repoDir)} && ${repo.setup.install}`,
				"Reinstall dependencies (lockfile changed)",
			);
		}

		const expiresAt = new Date(
			Date.now() + sandboxConfig.timeoutSeconds * 1000,
		);
		await markSandboxReady(recordId, refs.baseSha, newHash, expiresAt);

		return {
			sandbox,
			sandboxRecordId: recordId,
			repoDir,
			baseBranch: repo.baseBranch,
			baseSha: refs.baseSha,
			headSha: refs.headSha,
		};
	} catch (err) {
		await sandbox.terminate().catch(() => {});
		await markSandboxFailed(recordId);
		throw err;
	}
}

async function fetchAndCheckout(
	sandbox: Sandbox,
	ref: WorkspaceRef,
	repo: ReturnType<typeof target>,
	repoDir: string,
): Promise<{ baseSha: string; headSha: string }> {
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
		const headSha = shaResult.output.trim();

		await sandbox.mustRun(
			`git -C ${shellEscape(repoDir)} checkout ${shellEscape(headSha)}`,
			`Checkout branch ${ref.name}`,
		);

		return { baseSha: headSha, headSha };
	}

	if (ref.kind === "pull") {
		await fetchWithReadToken(sandbox, repoDir, `refs/pull/${ref.number}/head`, {
			owner: repo.owner,
			repo: repo.name,
		});
		await fetchWithReadToken(sandbox, repoDir, repo.baseBranch, {
			owner: repo.owner,
			repo: repo.name,
		});

		await sandbox.mustRun(
			`git -C ${shellEscape(repoDir)} checkout ${shellEscape(ref.headSha)}`,
			`Checkout PR #${ref.number} at ${ref.headSha.slice(0, 8)}`,
		);

		const mergeBaseResult = await sandbox.run(
			`git -C ${shellEscape(repoDir)} merge-base ${shellEscape(`origin/${repo.baseBranch}`)} ${shellEscape(ref.headSha)}`,
		);
		if (mergeBaseResult.exitCode !== 0) {
			throw new Error(`Failed to compute merge-base for PR #${ref.number}`);
		}

		return { baseSha: mergeBaseResult.output.trim(), headSha: ref.headSha };
	}

	// sha
	await fetchWithReadToken(sandbox, repoDir, ref.sha, {
		owner: repo.owner,
		repo: repo.name,
	});
	await sandbox.mustRun(
		`git -C ${shellEscape(repoDir)} checkout ${shellEscape(ref.sha)}`,
		`Checkout SHA ${ref.sha.slice(0, 8)}`,
	);

	return { baseSha: ref.sha, headSha: ref.sha };
}

/**
 * Terminate every sandbox recorded for the run and mark it terminated.
 * Idempotent; termination errors are logged, the row is still marked.
 */
export async function closeWorkspace(runId: string): Promise<void> {
	const sandboxes = await listSandboxesForRun(runId);
	for (const record of sandboxes) {
		try {
			if (record.providerId) {
				const sb = connectSandbox(record.providerId);
				await sb.terminate();
			}
		} catch (err) {
			console.error(
				`Failed to terminate sandbox ${record.id} for run ${runId}:`,
				err instanceof Error ? err.message : err,
			);
		}
		await markSandboxTerminated(record.id);
	}
}
