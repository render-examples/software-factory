import type { RepoContext } from "../config/index.js";
import { githubApiUrl, githubToken } from "./auth.js";

const SHA = /^[0-9a-f]{40}$/;
const MAX_ATTEMPTS = 5;
const MAX_RETRY_AFTER_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

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
	/** Throws GitDataError with status 422 when the branch already exists. */
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

export class GitDataError extends Error {
	constructor(
		readonly status: number,
		readonly method: string,
		readonly path: string,
		readonly body: string,
	) {
		super(`GitHub ${method} ${path} failed (${status}): ${body.slice(0, 300)}`);
		this.name = "GitDataError";
	}
}

/** `heads/<branch>` with each segment encoded, so slashes in the branch name stay path separators. */
export function headsPath(branch: string): string {
	return `heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

export function gitData(repo: RepoContext, opts: GitDataOptions = {}): GitDataClient {
	const fetchImpl = opts.fetch ?? fetch;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const token =
		opts.token ??
		(() =>
			githubToken({
				installationId: repo.installationId,
				repo: repo.name,
				permissions: { contents: "write" },
				fetch: opts.fetch,
			}));
	const prefix = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/git`;

	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${githubApiUrl()}${prefix}${path}`;
		for (let attempt = 1; ; attempt++) {
			let response: Response;
			try {
				response = await fetchImpl(url, {
					method,
					headers: {
						Authorization: `Bearer ${await token()}`,
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
						"User-Agent": "software-factory",
						...(body === undefined ? {} : { "Content-Type": "application/json" }),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
			} catch (err) {
				if (attempt >= MAX_ATTEMPTS) throw err;
				await sleep(backoffMs(attempt));
				continue;
			}
			if (response.ok) return (response.status === 204 ? undefined : await response.json()) as T;
			const text = await response.text().catch(() => "");
			const delay = retryDelayMs(response, text, attempt);
			if (delay === null || attempt >= MAX_ATTEMPTS) throw new GitDataError(response.status, method, path, text);
			await sleep(delay);
		}
	}

	return {
		async getCommit(sha) {
			const result = await request<{
				sha?: string;
				tree?: { sha?: string };
				parents?: Array<{ sha?: string }>;
			}>("GET", `/commits/${requireSha(sha, "commit")}`);
			const parents = (result.parents ?? []).map((p) => requireSha(p.sha, "parent"));
			const commit = {
				sha: requireSha(result.sha, "commit"),
				treeSha: requireSha(result.tree?.sha, "tree"),
				parents,
			};
			if (commit.sha !== sha) throw new Error(`GitHub returned commit ${commit.sha} for ${sha}`);
			return commit;
		},

		async createBlob(content) {
			const result = await request<{ sha?: string }>("POST", "/blobs", {
				content: content.toString("base64"),
				encoding: "base64",
			});
			return requireSha(result.sha, "blob");
		},

		async createTree(baseTree, entries) {
			const result = await request<{ sha?: string }>("POST", "/trees", {
				base_tree: requireSha(baseTree, "base tree"),
				tree: entries,
			});
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
			try {
				const result = await request<{
					ref?: string;
					object?: { sha?: string; type?: string };
				}>("GET", `/ref/${headsPath(branch)}`);
				if (result.ref !== `refs/heads/${branch}`)
					throw new Error(`GitHub returned ${result.ref} for refs/heads/${branch}`);
				if (result.object?.type !== "commit")
					throw new Error(`refs/heads/${branch} points at a ${result.object?.type}`);
				return requireSha(result.object.sha, "ref target");
			} catch (err) {
				if (err instanceof GitDataError && err.status === 404) return null;
				throw err;
			}
		},

		async createRef(branch, sha) {
			await request("POST", "/refs", {
				ref: `refs/heads/${branch}`,
				sha: requireSha(sha, "commit"),
			});
		},

		async updateRef(branch, sha, { force = false } = {}) {
			await request("PATCH", `/refs/${headsPath(branch)}`, {
				sha: requireSha(sha, "commit"),
				force,
			});
		},
	};
}

function requireSha(value: unknown, what: string): string {
	if (typeof value !== "string" || !SHA.test(value)) throw new Error(`Invalid ${what} SHA: ${String(value)}`);
	return value;
}

function backoffMs(attempt: number): number {
	return Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_AFTER_MS);
}

/** Milliseconds to wait before retrying, or null when the response isn't retryable. */
function retryDelayMs(response: Response, body: string, attempt: number): number | null {
	const rateLimited =
		response.status === 429 ||
		(response.status === 403 &&
			(response.headers.has("retry-after") ||
				response.headers.get("x-ratelimit-remaining") === "0" ||
				/secondary rate limit/i.test(body)));
	if (!rateLimited && response.status < 500) return null;

	const retryAfter = Number(response.headers.get("retry-after"));
	if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
	const reset = Number(response.headers.get("x-ratelimit-reset"));
	if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
		return Math.min(Math.max(reset * 1000 - Date.now(), 1000), MAX_RETRY_AFTER_MS);
	}
	// GitHub asks for at least a minute after a secondary rate limit that names no wait.
	return rateLimited ? MAX_RETRY_AFTER_MS : backoffMs(attempt);
}
