import { createHash, randomUUID } from "node:crypto";
import { factoryConfig } from "../../factory.config.js";
import { target, repository } from "../config/index.js";
import { githubToken, GitHub } from "../github/index.js";
import {
	createSandbox,
	createAndWaitSnapshot,
	deleteSnapshot,
	SandboxSnapshotNotFoundError,
	type CreateSandboxResult,
} from "../sandbox/index.js";
import type { Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";
import { BROWSER_DIR, PLAYWRIGHT_VERSION } from "../tools/index.js";
import {
	withAdvisoryLock,
	recordSandbox,
	setSandboxProviderId,
	markSandboxPreparing,
	markSandboxFailed,
	markSandboxTerminated,
	currentSnapshot,
	recordSnapshot,
	retireOtherSnapshots,
	listRetiredSnapshots,
	deleteSnapshotRecord,
	type SnapshotRecord,
} from "../store/index.js";
import { cloneWithReadToken, verifyNoCredentialLeak } from "./credentials.js";
import { lockfileHashInSandbox } from "./hash.js";

export { SandboxSnapshotNotFoundError };

/** Minimum remaining lifetime before we rebuild. */
const EXPIRY_BUFFER_MS = 12 * 60 * 60_000;
const ADVISORY_LOCK_KEY = 83927;

export interface EnsureSnapshotResult {
	snapshot: SnapshotRecord;
	rebuilt: boolean;
}

/**
 * Ensure an up-to-date snapshot exists for the current repo.
 * Acquires a Postgres advisory lock so only one process builds at a time.
 */
export async function ensureSnapshot(): Promise<EnsureSnapshotResult> {
	return withAdvisoryLock(ADVISORY_LOCK_KEY, ensureSnapshotLocked);
}

async function ensureSnapshotLocked(): Promise<EnsureSnapshotResult> {
	const repo = target();
	const repoRef = repository();
	const repoKey = `${repoRef.owner}/${repoRef.repo}`;

	const gh = new GitHub(() =>
		githubToken({ permissions: { contents: "read" } }),
	);
	const tipSha = await gh.getBranchTipSha(repoRef, repo.baseBranch);

	const existing = await currentSnapshot(repoKey);
	if (existing) {
		const expiresOk =
			!existing.expiresAt ||
			new Date(existing.expiresAt).getTime() > Date.now() + EXPIRY_BUFFER_MS;
		const candidateBuildKey = computeBuildKey(repo, tipSha);
		if (
			existing.buildKey === candidateBuildKey &&
			existing.baseSha === tipSha &&
			expiresOk
		) {
			return { snapshot: existing, rebuilt: false };
		}
	}

	const snapshot = await buildSnapshot(repo, repoRef, repoKey);
	return { snapshot, rebuilt: true };
}

function computeBuildKey(
	repo: ReturnType<typeof target>,
	baseSha: string,
): string {
	const parts = [
		baseSha,
		repo.setup.install,
		repo.setup.browsers ? "browsers" : "no-browsers",
		PLAYWRIGHT_VERSION,
		process.env.RENDER_GIT_COMMIT ?? "development",
	];
	return createHash("sha256").update(parts.join("\n")).digest("hex");
}

const MANIFEST_PATH = "/home/user/.factory/manifest.json";

async function buildSnapshot(
	repo: ReturnType<typeof target>,
	repoRef: ReturnType<typeof repository>,
	repoKey: string,
): Promise<SnapshotRecord> {
	const sandboxConfig = factoryConfig.sandbox;
	const builderTimeout = sandboxConfig.builderTimeoutSeconds ?? 7_200;
	const recordId = randomUUID();

	await recordSandbox({
		id: recordId,
		status: "creating",
		role: "builder",
	});

	let sandbox: Sandbox | undefined;
	try {
		const result: CreateSandboxResult = await createSandbox({
			timeoutSeconds: builderTimeout,
			networkPolicy: { default: "allow-all" },
		});
		sandbox = result.sandbox;
		await setSandboxProviderId(recordId, sandbox.id);
		await markSandboxPreparing(recordId);
	} catch (err) {
		await markSandboxFailed(recordId);
		throw err;
	}

	try {
		await cloneWithReadToken(
			sandbox,
			{ owner: repoRef.owner, repo: repoRef.repo, branch: repo.baseBranch },
			repo.repoDir,
		);

		const realBaseSha = (
			await sandbox.mustRun(
				`git -C ${shellEscape(repo.repoDir)} rev-parse HEAD`,
				"Determine base SHA",
			)
		).trim();

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

		const lockfileHash = await lockfileHashInSandbox(sandbox, repo.repoDir);
		const buildKey = computeBuildKey(repo, realBaseSha);

		const manifest = {
			repo: repoKey,
			baseSha: realBaseSha,
			lockfileHash,
			buildKey,
		};
		await sandbox.writeFile(MANIFEST_PATH, JSON.stringify(manifest));

		const verifyManifest = JSON.parse(await sandbox.readFile(MANIFEST_PATH));
		if (
			verifyManifest.baseSha !== realBaseSha ||
			verifyManifest.buildKey !== buildKey
		) {
			throw new Error("Manifest verification failed after write");
		}

		await verifyNoCredentialLeak(
			sandbox,
			repo.repoDir,
			repoRef.owner,
			repoRef.repo,
		);

		const snapshotName = `render-factory-${repoRef.owner}-${repoRef.repo}`;
		const snap = await createAndWaitSnapshot({
			sandboxId: sandbox.id,
			kind: "filesystem",
			name: snapshotName,
		});

		await recordSnapshot({
			id: snap.id,
			sandboxGroupId: snap.sandboxGroupId,
			name: snapshotName,
			repo: repoKey,
			baseSha: realBaseSha,
			lockfileHash,
			buildKey,
			expiresAt: snap.expiresAt ? new Date(snap.expiresAt) : undefined,
		});

		const retired = await retireOtherSnapshots(repoKey, snap.id);
		await pruneRetiredSnapshots(retired, snap.sandboxGroupId);

		const result = await currentSnapshot(repoKey);
		if (!result) {
			throw new Error("Snapshot was recorded but could not be read back");
		}
		return result;
	} finally {
		try {
			await sandbox.terminate();
		} catch {
			/* builder cleanup is best-effort */
		}
		await markSandboxTerminated(recordId);
	}
}

async function pruneRetiredSnapshots(
	retiredIds: string[],
	sandboxGroupId: string,
): Promise<void> {
	for (const id of retiredIds) {
		try {
			await deleteSnapshot({ sandboxGroupId, snapshotId: id });
			await deleteSnapshotRecord(id);
		} catch (err) {
			console.error(
				`Prune snapshot ${id} failed:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
}

/**
 * Prune all retired snapshots for the repo.
 * Called from maintenance; failures are logged.
 */
export async function pruneAllRetiredSnapshots(repo: string): Promise<void> {
	const retired = await listRetiredSnapshots(repo);
	for (const snap of retired) {
		try {
			await deleteSnapshot({
				sandboxGroupId: snap.sandboxGroupId,
				snapshotId: snap.id,
			});
			await deleteSnapshotRecord(snap.id);
		} catch (err) {
			console.error(
				`Prune retired snapshot ${snap.id} failed:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
}
