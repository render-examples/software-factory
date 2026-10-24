import { randomUUID } from "node:crypto";
import { config, type RepoContext } from "../config/index.js";
import { type GitDataClient, GitHubError, type GitIdentity, gitData as gitDataClient, type TreeEntry } from "../github/index.js";
import { SAFE_REF, shq } from "../sandbox/shell.js";
import { APP_DIR, REPO_DIR, type Sandbox } from "../sandbox/types.js";
import { type ChangedFile, checkChanges, type PublishLimits, parseChangesFile, type RefusalReason } from "./changes.js";

export { blobSha, type ChangedFile, type RefusalReason } from "./changes.js";

/** `bash ${COLLECT_CHANGES_SCRIPT} <repo_dir> <base_sha> <out_file> <max_changed_files> <max_file_bytes>`; see the script. */
const COLLECT_CHANGES_SCRIPT = `${APP_DIR}/collect-changes.sh`;

const DEFAULT_IDENTITY = {
	name: "software-factory[bot]",
	email: "software-factory[bot]@users.noreply.github.com",
} as const;

const SHA = /^[0-9a-f]{40}$/;
const COLLECT_TIMEOUT_MS = 10 * 60 * 1000;
/** Slack per changed file in the output file for its diff record, size line, and blob header (paths cap at 4096). */
const PER_FILE_OVERHEAD = 4096 + 300;

export interface PublishInput {
	sandbox: Sandbox;
	repo: RepoContext;
	/** The commit the run started from; the branch's only parent. */
	baseSha: string;
	branch: string;
	message: string;
	/** Author and committer. Pass a fixed `date` to make retries produce the same commit. */
	author?: GitIdentity;
	gitData?: GitDataClient;
	/** Defaults to `config.limits`. */
	limits?: PublishLimits;
	/** Commits an earlier attempt of this run created: the branch may be moved off them as well as off baseSha. */
	ownedCommits?: readonly string[];
}

/** Test seams: where the script and checkout live, and where the output goes. */
export interface PublishPaths {
	scriptPath?: string;
	repoDir?: string;
	outPath?: string;
}

export interface Published {
	commitSha: string;
	treeSha: string;
	changedFiles: ChangedFile[];
}

export type PublishResult = Published | { refused: RefusalReason[] };

/**
 * Publishes the sandbox's working tree as one commit on `refs/heads/<branch>`, through the Git Data API with a
 * token that never enters the sandbox. Returns a refusal when the change breaks a publishing rule, and throws
 * on any verification mismatch, before a ref moves.
 */
export async function publish(input: PublishInput, paths: PublishPaths = {}): Promise<PublishResult> {
	const { sandbox, repo, baseSha, branch, message } = input;
	if (!SHA.test(baseSha)) throw new Error(`Invalid base SHA: ${baseSha}`);
	if (!isSafeBranch(branch)) throw new Error(`Invalid branch name: ${branch}`);
	if (!message.trim()) throw new Error("Commit message is empty");
	const limits = input.limits ?? config.limits;
	const identity = input.author ?? DEFAULT_IDENTITY;

	const file = await collect(sandbox, baseSha, limits, paths);
	const checked = checkChanges(parseChangesFile(file), limits);
	if ("refused" in checked) return checked;

	const git = input.gitData ?? gitDataClient(repo);
	const base = await git.getCommit(baseSha);

	for (const [sha, content] of checked.blobs) {
		const created = await git.createBlob(content);
		if (created !== sha) throw new Error(`GitHub stored blob ${created}, expected ${sha}`);
	}

	const treeSha = await git.createTree(base.treeSha, treeEntries(checked.files));
	if (treeSha !== checked.treeSha) {
		throw new Error(`Tree mismatch: GitHub built ${treeSha}, the sandbox staged ${checked.treeSha}`);
	}

	const commitSha = await git.createCommit({
		message,
		tree: treeSha,
		parents: [baseSha],
		author: identity,
		committer: identity,
	});
	await moveBranch(git, branch, commitSha, new Set([baseSha]), new Set(input.ownedCommits ?? []));
	return { commitSha, treeSha, changedFiles: checked.files };
}

/** Runs collect-changes.sh and downloads its one output file, checking its size before and after. */
async function collect(sandbox: Sandbox, baseSha: string, limits: PublishLimits, paths: PublishPaths): Promise<Buffer> {
	const outPath = paths.outPath ?? `/tmp/software-factory-changes-${randomUUID()}`;
	const command = [
		"bash",
		shq(paths.scriptPath ?? COLLECT_CHANGES_SCRIPT),
		shq(paths.repoDir ?? REPO_DIR),
		shq(baseSha),
		shq(outPath),
		String(limits.maxChangedFiles),
		String(limits.maxFileBytes),
	].join(" ");
	const result = await sandbox.exec(command, { timeoutMs: COLLECT_TIMEOUT_MS });
	if (result.exitCode !== 0) {
		throw new Error(`collect-changes.sh failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-500)}`);
	}
	const reported = result.stdout.trim();
	if (!/^\d{1,15}$/.test(reported)) throw new Error(`collect-changes.sh printed "${reported.slice(0, 80)}", not a size`);
	const bytes = Number(reported);
	const maxBytes = limits.maxChangedFiles * (limits.maxFileBytes + PER_FILE_OVERHEAD) + 4096;
	if (bytes > maxBytes) throw new Error(`Changes file is ${bytes} bytes, more than the ${maxBytes} the limits allow`);

	const file = await sandbox.download(outPath);
	if (file.length !== bytes) throw new Error(`Downloaded ${file.length} bytes of a ${bytes}-byte changes file`);
	return file;
}

/**
 * Deletions go first: GitHub applies entries in order, so turning a file into a directory (or back) needs the
 * old entry gone before the new one lands.
 */
function treeEntries(files: ChangedFile[]): TreeEntry[] {
	const byPath = (a: ChangedFile, b: ChangedFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	const deletions = files.filter((f) => f.sha === null).sort(byPath);
	const writes = files.filter((f) => f.sha !== null).sort(byPath);
	return [
		...deletions.map((f): TreeEntry => ({ path: f.path, mode: "100644", type: "blob", sha: null })),
		...writes.map((f): TreeEntry => {
			if (f.mode !== "100644" && f.mode !== "100755") throw new Error(`Refusing to write ${f.path} with mode ${f.mode}`);
			return { path: f.path, mode: f.mode, type: "blob", sha: f.sha };
		}),
	];
}

/**
 * Points the branch at `commitSha`: creates it, fast-forwards it from the base, or moves it off a commit this
 * run created. Any other target belongs to someone else and is left alone.
 */
async function moveBranch(
	git: GitDataClient,
	branch: string,
	commitSha: string,
	base: ReadonlySet<string>,
	owned: ReadonlySet<string>,
): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const current = await git.getRef(branch);
		if (current === commitSha) return;
		if (current === null) {
			try {
				await git.createRef(branch, commitSha);
			} catch (err) {
				if (err instanceof GitHubError && err.status === 422) continue;
				throw err;
			}
		} else if (base.has(current)) {
			await git.updateRef(branch, commitSha, { force: false });
		} else if (owned.has(current)) {
			await git.updateRef(branch, commitSha, { force: true });
		} else {
			throw new Error(`Refusing to move refs/heads/${branch}: it points at ${current}, which this run didn't create`);
		}
		const after = await git.getRef(branch);
		if (after !== commitSha) throw new Error(`refs/heads/${branch} points at ${after}, expected ${commitSha}`);
		return;
	}
	throw new Error(`refs/heads/${branch} kept changing while publishing`);
}

/** A branch name git and GitHub both accept, with nothing that reads as a refspec, option, or revision. */
function isSafeBranch(branch: string): boolean {
	return (
		SAFE_REF.test(branch) &&
		branch.length <= 200 &&
		!branch.includes("..") &&
		!branch.includes("//") &&
		!branch.endsWith("/") &&
		!branch.endsWith(".") &&
		!branch.endsWith(".lock") &&
		!branch.split("/").some((s) => s.startsWith("."))
	);
}
