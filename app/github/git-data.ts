/**
 * Git Data API calls for publishing commits from the Workflows service.
 * All blob/tree/commit/ref operations go through here, not in client.ts.
 */
import { repository } from "../config/index.js";
import { githubToken } from "./auth.js";
import { GitHubHttp } from "./request.js";

export interface TreeEntry {
	path: string;
	/** "100644" (normal), "100755" (executable). Deletions use sha: null. */
	mode: string;
	type: "blob";
	sha: string | null;
}

export interface CommitIdentity {
	name: string;
	email: string;
	date: string;
}

export interface GitDataClient {
	createBlob(content: Buffer): Promise<string>;
	createTree(baseTree: string, entries: TreeEntry[]): Promise<string>;
	createCommit(opts: {
		message: string;
		tree: string;
		parents: string[];
		author: CommitIdentity;
		committer: CommitIdentity;
	}): Promise<string>;
	getRef(ref: string): Promise<string | null>;
	createRef(ref: string, sha: string): Promise<void>;
}

/**
 * Ensure a ref exists pointing at the expected commit. If the ref already
 * exists and points at the same SHA, succeed. If it points elsewhere,
 * fail closed — another process created a conflicting branch.
 */
export async function ensureRef(
	client: GitDataClient,
	ref: string,
	sha: string,
): Promise<void> {
	const existing = await client.getRef(ref);
	if (existing === sha) return;
	if (existing !== null) {
		throw new Error(
			`Ref ${ref} already exists at ${existing.slice(0, 12)}, expected ${sha.slice(0, 12)}`,
		);
	}
	await client.createRef(ref, sha);
}

/** Build a GitDataClient that talks to the GitHub REST API. */
export function gitDataClient(fetchImpl: typeof fetch = fetch): GitDataClient {
	const repo = repository();
	const http = new GitHubHttp(
		() => githubToken({ permissions: { contents: "write" } }),
		fetchImpl,
	);

	return {
		async createBlob(content: Buffer): Promise<string> {
			const result = await http.send<{ sha: string }>(
				"POST",
				`/repos/${repo.owner}/${repo.repo}/git/blobs`,
				{
					body: {
						content: content.toString("base64"),
						encoding: "base64",
					},
				},
			);
			return result.sha;
		},

		async createTree(baseTree: string, entries: TreeEntry[]): Promise<string> {
			const result = await http.send<{ sha: string }>(
				"POST",
				`/repos/${repo.owner}/${repo.repo}/git/trees`,
				{
					body: {
						base_tree: baseTree,
						tree: entries.map((e) => ({
							path: e.path,
							mode: e.mode,
							type: e.type,
							sha: e.sha,
						})),
					},
				},
			);
			return result.sha;
		},

		async createCommit(opts: {
			message: string;
			tree: string;
			parents: string[];
			author: CommitIdentity;
			committer: CommitIdentity;
		}): Promise<string> {
			const result = await http.send<{ sha: string }>(
				"POST",
				`/repos/${repo.owner}/${repo.repo}/git/commits`,
				{
					body: {
						message: opts.message,
						tree: opts.tree,
						parents: opts.parents,
						author: opts.author,
						committer: opts.committer,
					},
				},
			);
			return result.sha;
		},

		async getRef(ref: string): Promise<string | null> {
			try {
				const result = await http.send<{ object: { sha: string } }>(
					"GET",
					`/repos/${repo.owner}/${repo.repo}/git/ref/${encodeURIComponent(ref).replace(/%2F/g, "/")}`,
				);
				return result.object.sha;
			} catch (err) {
				if (
					err &&
					typeof err === "object" &&
					"status" in err &&
					(err as { status: number }).status === 404
				) {
					return null;
				}
				throw err;
			}
		},

		async createRef(ref: string, sha: string): Promise<void> {
			await http.send("POST", `/repos/${repo.owner}/${repo.repo}/git/refs`, {
				body: { ref: `refs/${ref}`, sha },
			});
		},
	};
}
