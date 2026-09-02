import { redactSecrets } from "../policy/index.js";
import {
	type RawComment,
	type RawIssue,
	type RawPull,
	toComment,
	toIssue,
	toPull,
} from "./raw.js";
import { GitHubHttp } from "./request.js";
import {
	GitHubError,
	type Issue,
	type IssueComment,
	type PullRequest,
	type RepoRef,
} from "./types.js";

/** Workflow-owned GitHub operations. Agents never touch this. */
export class GitHub {
	private readonly http: GitHubHttp;

	constructor(token: string, fetchImpl: typeof fetch = fetch, api?: string) {
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

export function githubFromEnv(fetchImpl: typeof fetch = fetch): GitHub {
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		throw new Error("GITHUB_TOKEN is not set — a fine-grained PAT is required");
	}
	return new GitHub(token, fetchImpl);
}
