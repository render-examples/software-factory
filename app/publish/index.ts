/**
 * Publish the sandbox state to GitHub through the Git Data API.
 *
 * The publish path is: collect changes → transfer files → create blobs →
 * create tree → **verify tree hash** → create commit → create ref → verify ref.
 * No write-capable credential ever enters the sandbox.
 */
import { target } from "../config/index.js";
import { git } from "../git/index.js";
import {
	ensureRef,
	type CommitIdentity,
	type GitDataClient,
	type TreeEntry,
} from "../github/index.js";
import { shellEscape } from "../shell/index.js";
import type { Sandbox } from "../sandbox/index.js";
import {
	checkTotalSize,
	collectChanges,
	type ChangeSet,
	type RefusalReason,
} from "./changes.js";
import { parseTar } from "./tar.js";

export type {
	ChangeEntry,
	ChangeSet,
	ChangeStatus,
	RefusalReason,
} from "./changes.js";
export { parseDiffRaw, collectChanges, checkTotalSize } from "./changes.js";
export { parseTar, parsePaxData, type TarEntry } from "./tar.js";

const IDENTITY_NAME = "render-factory[bot]";
const IDENTITY_EMAIL = "bot@render-factory.dev";

export interface PublishResult {
	commitSha: string;
	treeSha: string;
	branch: string;
}

export interface PublishOptions {
	sandbox: Sandbox;
	gitData: GitDataClient;
	baseSha: string;
	branch: string;
	message: string;
	/** ISO-8601 timestamp fixed per run for deterministic commits. */
	authorDate: string;
}

/**
 * Publish the sandbox working tree to GitHub via the Git Data API.
 *
 * Returns either a successful PublishResult or a list of refusal reasons.
 * On any verification mismatch, throws — fail closed, no PR.
 */
export async function publish(
	opts: PublishOptions,
): Promise<
	{ ok: true; result: PublishResult } | { ok: false; reasons: RefusalReason[] }
> {
	const { sandbox, gitData, baseSha, branch, message, authorDate } = opts;

	// ── 1. Collect changes ──────────────────────────────────────────
	const collected = await collectChanges(sandbox, baseSha);
	if (!collected.ok) return collected;
	const changes: ChangeSet = collected.changes;

	if (changes.entries.length === 0) {
		return {
			ok: false,
			reasons: [{ kind: "empty", detail: "No changes to publish" }],
		};
	}

	// ── 2. Transfer files from sandbox ──────────────────────────────
	const fileContents = await transferFiles(sandbox, changes);

	const sizeCheck = checkTotalSize(fileContents);
	if (sizeCheck) return { ok: false, reasons: [sizeCheck] };

	// ── 3. Create blobs ─────────────────────────────────────────────
	const blobShas = new Map<string, string>();
	for (const entry of changes.additions) {
		const content = fileContents.get(entry.path);
		if (!content) {
			throw new Error(`Missing file content for ${entry.path}`);
		}
		const sha = await gitData.createBlob(content);
		blobShas.set(entry.path, sha);
	}

	// ── 4. Create tree ──────────────────────────────────────────────
	const baseTreeSha = await getBaseTreeSha(sandbox, baseSha);
	const treeEntries: TreeEntry[] = [];

	for (const entry of changes.additions) {
		const blobSha = blobShas.get(entry.path);
		if (!blobSha) throw new Error(`No blob for ${entry.path}`);
		treeEntries.push({
			path: entry.path,
			mode: entry.mode === "100755" ? "100755" : "100644",
			type: "blob",
			sha: blobSha,
		});
	}

	for (const entry of changes.deletions) {
		treeEntries.push({
			path: entry.path,
			mode: "100644",
			type: "blob",
			sha: null,
		});
	}

	const treeSha = await gitData.createTree(baseTreeSha, treeEntries);

	// ── 5. Verify tree hash BEFORE creating commit or ref ───────────
	const localTreeSha = (
		await git(sandbox, "rev-parse HEAD^{tree}", "Local tree SHA")
	).trim();

	if (treeSha !== localTreeSha) {
		throw new Error(
			`Tree hash mismatch: GitHub returned ${treeSha}, sandbox has ${localTreeSha}. Failing closed — no commit or ref created.`,
		);
	}

	// ── 6. Create commit ────────────────────────────────────────────
	const identity: CommitIdentity = {
		name: IDENTITY_NAME,
		email: IDENTITY_EMAIL,
		date: authorDate,
	};

	const commitSha = await gitData.createCommit({
		message,
		tree: treeSha,
		parents: [baseSha],
		author: identity,
		committer: identity,
	});

	// ── 7. Create ref ───────────────────────────────────────────────
	await ensureRef(gitData, `heads/${branch}`, commitSha);

	// ── 8. Verify ref points at the new commit ──────────────────────
	const remoteRef = await gitData.getRef(`heads/${branch}`);
	if (remoteRef !== commitSha) {
		throw new Error(
			`Ref verification failed: expected ${commitSha}, got ${remoteRef}. Failing closed.`,
		);
	}

	return {
		ok: true,
		result: { commitSha, treeSha, branch },
	};
}

/** Get the tree SHA of the base commit for base_tree in createTree. */
async function getBaseTreeSha(
	sandbox: Sandbox,
	baseSha: string,
): Promise<string> {
	return (
		await git(
			sandbox,
			`rev-parse ${shellEscape(baseSha)}^{tree}`,
			"Base tree SHA",
		)
	).trim();
}

/**
 * Transfer files from the sandbox using `git archive`. The archive
 * is downloaded as a tar and parsed in-process.
 */
async function transferFiles(
	sandbox: Sandbox,
	changes: ChangeSet,
): Promise<Map<string, Buffer>> {
	if (changes.additions.length === 0) return new Map();

	const paths = changes.additions.map((e) => shellEscape(e.path)).join(" ");
	const archivePath = "/tmp/render-factory-archive.tar";
	const repo = target();

	await sandbox.mustRun(
		`cd ${shellEscape(repo.repoDir)} && git archive HEAD -- ${paths} > ${shellEscape(archivePath)}`,
		"Create archive",
	);

	const tarBuffer = await sandbox.download(archivePath);
	const entries = parseTar(tarBuffer);

	const fileMap = new Map<string, Buffer>();
	for (const entry of entries) {
		fileMap.set(entry.path, entry.data);
	}

	return fileMap;
}
