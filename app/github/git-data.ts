import type { RepoContext } from "../config/index.js";
import { githubToken } from "./auth.js";
import { encodePath, GitHubHttp } from "./request.js";
import { GitHubError } from "./types.js";

const SHA = /^[0-9a-f]{40}$/;

export type FileMode = "100644" | "100755";

export interface TreeEntry {
	path: string;
	mode: FileMode;
	type: "blob";
	/** null deletes the path from the base tree. */
	sha: string | null;
}

export interface GitIdentity {
	name: string;
	email: string;
	/** ISO 8601. GitHub uses the current time when omitted. */
	date?: string;
}

export interface GitCommit {
	sha: string;
	treeSha: string;
	parents: string[];
	/** As recorded in the commit. Anyone who can push can write any identity here, so it shows intent, not proof. */
	author?: GitIdentity;
	committer?: GitIdentity;
}

export interface CreateCommitInput {
	message: string;
	tree: string;
	parents: string[];
	author: GitIdentity;
	committer: GitIdentity;
}

/** Git Data API calls for one repository. Every call uses a contents:write token that stays on the host. */
export interface GitDataClient {
	getCommit(sha: string): Promise<GitCommit>;
	/** Returns the blob's SHA as GitHub computed it. */
	createBlob(content: Buffer): Promise<string>;
	createTree(baseTree: string, entries: TreeEntry[]): Promise<string>;
	createCommit(input: CreateCommitInput): Promise<string>;
	/** The commit a branch points at, or null when the branch doesn't exist. */
	getRef(branch: string): Promise<string | null>;
	/** Throws GitHubError with status 422 when the branch already exists. */
	createRef(branch: string, sha: string): Promise<void>;
	/** Without force, GitHub refuses (422) unless the move is a fast-forward. */
	updateRef(branch: string, sha: string, opts?: { force?: boolean }): Promise<void>;
}

export interface GitDataOptions {
	fetch?: typeof fetch;
	/** Test seam: replaces the installation token exchange. */
	token?: () => Promise<string>;
	/** Test seam: replaces the delay between retries. */
	sleep?: (ms: number) => Promise<void>;
}

export function gitData(repo: RepoContext, opts: GitDataOptions = {}): GitDataClient {
	const token =
		opts.token ??
		(() => githubToken({ installationId: repo.installationId, repo: repo.name, permissions: { contents: "write" }, fetch: opts.fetch }));
	const http = new GitHubHttp(token, { fetch: opts.fetch, sleep: opts.sleep, timeoutMs: 30_000, maxAttempts: 5 });
	const prefix = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/git`;
	// Blobs, trees, and commits are content-addressed and ref moves are compare-and-set, so every call is safe to retry.
	const request = <T>(method: string, path: string, body?: unknown) => http.json<T>(method, `${prefix}${path}`, { body, idempotent: true });
	const heads = (branch: string) => `heads/${encodePath(branch)}`;

	return {
		async getCommit(sha) {
			const result = await request<{
				sha?: string;
				tree?: { sha?: string };
				parents?: Array<{ sha?: string }>;
				author?: RawIdentity;
				committer?: RawIdentity;
			}>("GET", `/commits/${requireSha(sha, "commit")}`);
			const commit: GitCommit = {
				sha: requireSha(result.sha, "commit"),
				treeSha: requireSha(result.tree?.sha, "tree"),
				parents: (result.parents ?? []).map((p) => requireSha(p.sha, "parent")),
				author: toIdentity(result.author),
				committer: toIdentity(result.committer),
			};
			if (commit.sha !== sha) throw new Error(`GitHub returned commit ${commit.sha} for ${sha}`);
			return commit;
		},

		async createBlob(content) {
			const result = await request<{ sha?: string }>("POST", "/blobs", { content: content.toString("base64"), encoding: "base64" });
			return requireSha(result.sha, "blob");
		},

		async createTree(baseTree, entries) {
			const result = await request<{ sha?: string }>("POST", "/trees", { base_tree: requireSha(baseTree, "base tree"), tree: entries });
			return requireSha(result.sha, "tree");
		},

		async createCommit(input) {
			const result = await request<{ sha?: string }>("POST", "/commits", {
				message: input.message,
				tree: requireSha(input.tree, "tree"),
				parents: input.parents.map((p) => requireSha(p, "parent")),
				author: input.author,
				committer: input.committer,
			});
			return requireSha(result.sha, "commit");
		},

		async getRef(branch) {
			let result: { ref?: string; object?: { sha?: string; type?: string } };
			try {
				result = await request("GET", `/ref/${heads(branch)}`);
			} catch (err) {
				if (err instanceof GitHubError && err.status === 404) return null;
				throw err;
			}
			if (result.ref !== `refs/heads/${branch}`) throw new Error(`GitHub returned ${result.ref} for refs/heads/${branch}`);
			if (result.object?.type !== "commit") throw new Error(`refs/heads/${branch} points at a ${result.object?.type}`);
			return requireSha(result.object.sha, "ref target");
		},

		async createRef(branch, sha) {
			await request("POST", "/refs", { ref: `refs/heads/${branch}`, sha: requireSha(sha, "commit") });
		},

		async updateRef(branch, sha, { force = false } = {}) {
			await request("PATCH", `/refs/${heads(branch)}`, { sha: requireSha(sha, "commit"), force });
		},
	};
}

interface RawIdentity {
	name?: string;
	email?: string;
	date?: string;
}

function toIdentity(raw: RawIdentity | undefined): GitIdentity | undefined {
	if (typeof raw?.name !== "string" || typeof raw.email !== "string") return undefined;
	return { name: raw.name, email: raw.email, date: typeof raw.date === "string" ? raw.date : undefined };
}

function requireSha(value: unknown, what: string): string {
	if (typeof value !== "string" || !SHA.test(value)) throw new Error(`Invalid ${what} SHA: ${String(value)}`);
	return value;
}
