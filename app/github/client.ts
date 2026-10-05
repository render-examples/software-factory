import { redactSecrets } from "../policy/index.js";
import { githubToken } from "./auth.js";
import {
	type RawComment,
	type RawContent,
	type RawIssue,
	type RawPull,
	type RawRepo,
	type RawTree,
	toComment,
	toIssue,
	toPull,
} from "./raw.js";
import { GitHubHttp, type TokenProvider } from "./request.js";
import {
	GitHubError,
	type Issue,
	type IssueComment,
	type PullRequest,
	type RepoRef,
	type RepoSnapshot,
} from "./types.js";

/** Paths that describe the project rather than implement it. */
const CONTEXT_FILES = ["README.md", "package.json"] as const;
const MAX_PATHS = 300;
const MAX_FILE_CHARS = 2_000;
const IGNORED_SEGMENTS = new Set([
	"node_modules",
	"dist",
	"build",
	"vendor",
	"coverage",
	"__snapshots__",
]);

/** Workflow-owned GitHub operations. Agents never touch this. */
export class GitHub {
	private readonly http: GitHubHttp;

	constructor(
		token: TokenProvider,
		fetchImpl: typeof fetch = fetch,
		api?: string,
	) {
		this.http = new GitHubHttp(token, fetchImpl, api);
	}

	async getIssue(ref: RepoRef, number: number): Promise<Issue> {
		return toIssue(
			await this.http.send<RawIssue>(
				"GET",
				`/repos/${ref.owner}/${ref.repo}/issues/${number}`,
			),
		);
	}

	async listIssueComments(
		ref: RepoRef,
		number: number,
	): Promise<IssueComment[]> {
		const raw: RawComment[] = [];
		for (let page = 1; page <= 10; page++) {
			const batch = await this.http.send<RawComment[]>(
				"GET",
				`/repos/${ref.owner}/${ref.repo}/issues/${number}/comments?per_page=100&page=${page}`,
			);
			raw.push(...batch);
			if (batch.length < 100) break;
			if (page === 10) throw new Error("Issue has more than 1,000 comments");
		}
		return raw.map(toComment);
	}

	/**
	 * The repository's shape and its self-describing files.
	 *
	 * Triage runs before any sandbox exists, so this is how it learns what the
	 * project is without a checkout. Three API calls, no clone.
	 */
	async getRepoSnapshot(ref: RepoRef): Promise<RepoSnapshot> {
		const repo = await this.http.send<RawRepo>(
			"GET",
			`/repos/${ref.owner}/${ref.repo}`,
		);
		const defaultBranch = repo.default_branch;

		const tree = await this.http.send<RawTree>(
			"GET",
			`/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
		);
		const all = (tree.tree ?? [])
			.filter((entry) => entry.type === "blob" && interesting(entry.path))
			.map((entry) => entry.path)
			.sort();

		const files: RepoSnapshot["files"] = [];
		for (const path of CONTEXT_FILES) {
			const content = await this.getTextFile(ref, path);
			if (content) files.push({ path, content });
		}

		return {
			defaultBranch,
			paths: all.slice(0, MAX_PATHS),
			truncated: tree.truncated === true || all.length > MAX_PATHS,
			files,
		};
	}

	/** A UTF-8 file's contents, or null when it does not exist. */
	async getTextFile(ref: RepoRef, path: string): Promise<string | null> {
		try {
			const raw = await this.http.send<RawContent>(
				"GET",
				`/repos/${ref.owner}/${ref.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
			);
			if (raw.encoding !== "base64" || !raw.content) return null;
			return Buffer.from(raw.content, "base64")
				.toString("utf8")
				.slice(0, MAX_FILE_CHARS);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return null;
			throw error;
		}
	}

	/** Post a comment at most once, identified by a hidden marker. */
	async ensureIssueComment(
		ref: RepoRef,
		number: number,
		operationId: string,
		body: string,
	): Promise<void> {
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
			throw new Error("Invalid comment operation ID");
		}
		const marker = `<!-- render-factory:${operationId} -->`;
		const comments = await this.listIssueComments(ref, number);
		if (comments.some((comment) => comment.body.includes(marker))) return;

		await this.http.send(
			"POST",
			`/repos/${ref.owner}/${ref.repo}/issues/${number}/comments`,
			{ body: { body: `${redactSecrets(body)}\n\n${marker}` } },
		);
	}

	/** Adding a label that does not exist in the repository creates it. */
	async addLabels(
		ref: RepoRef,
		number: number,
		labels: readonly string[],
	): Promise<void> {
		if (labels.length === 0) return;
		await this.http.send(
			"POST",
			`/repos/${ref.owner}/${ref.repo}/issues/${number}/labels`,
			{ body: { labels } },
		);
	}

	async removeLabel(
		ref: RepoRef,
		number: number,
		label: string,
	): Promise<void> {
		try {
			await this.http.send(
				"DELETE",
				`/repos/${ref.owner}/${ref.repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
			);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return;
			throw error;
		}
	}

	/**
	 * Get a user's repository permission level.
	 * Returns one of: admin, maintain, write, triage, read, none.
	 */
	async getPermission(ref: RepoRef, login: string): Promise<string> {
		const result = await this.http.send<{ permission: string }>(
			"GET",
			`/repos/${ref.owner}/${ref.repo}/collaborators/${encodeURIComponent(login)}/permission`,
		);
		return result.permission;
	}

	/** Reuse the open PR for this head, or open a new draft. */
	async ensurePull(
		ref: RepoRef,
		args: {
			title: string;
			head: string;
			base: string;
			body: string;
			expectedHeadSha: string;
		},
	): Promise<PullRequest> {
		const open = await this.http.send<RawPull[]>(
			"GET",
			`/repos/${ref.owner}/${ref.repo}/pulls?head=${ref.owner}:${encodeURIComponent(args.head)}&state=open`,
		);
		if (open.length > 0) {
			const existing = toPull(open[0]);
			if (existing.headSha !== args.expectedHeadSha) {
				throw new Error(
					"Existing pull request head does not match reviewed SHA",
				);
			}
			return existing;
		}

		return toPull(
			await this.http.send<RawPull>(
				"POST",
				`/repos/${ref.owner}/${ref.repo}/pulls`,
				{
					body: {
						title: args.title,
						head: args.head,
						base: args.base,
						body: redactSecrets(args.body),
						draft: true,
					},
				},
			),
		);
	}
}

function interesting(path: string): boolean {
	return !path
		.split("/")
		.some(
			(segment) => segment.startsWith(".") || IGNORED_SEGMENTS.has(segment),
		);
}

export function githubFromEnv(fetchImpl: typeof fetch = fetch): GitHub {
	return new GitHub(() => githubToken({ fetch: fetchImpl }), fetchImpl);
}
