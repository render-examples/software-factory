import { redactSecrets } from "../policy/index.js";
import type { GitHubHttp } from "./request.js";
import type { RepoRef } from "./types.js";

export interface PullDetail {
	number: number;
	state: string;
	headSha: string;
	baseSha: string;
	body: string;
	title: string;
	htmlUrl: string;
}

interface RawPullDetail {
	number: number;
	state: string;
	head: { sha: string };
	base: { sha: string };
	body: string | null;
	title: string;
	html_url: string;
}

/** Fetch a single pull request with state, SHAs, and body. */
export async function getPull(
	http: GitHubHttp,
	ref: RepoRef,
	number: number,
): Promise<PullDetail> {
	const raw = await http.send<RawPullDetail>(
		"GET",
		`/repos/${ref.owner}/${ref.repo}/pulls/${number}`,
	);
	return {
		number: raw.number,
		state: raw.state,
		headSha: raw.head.sha,
		baseSha: raw.base.sha,
		body: raw.body ?? "",
		title: raw.title,
		htmlUrl: raw.html_url,
	};
}

/** Fetch the unified diff for a PR via the diff media type. */
export async function getPullDiff(
	http: GitHubHttp,
	ref: RepoRef,
	number: number,
): Promise<string> {
	return http.send<string>(
		"GET",
		`/repos/${ref.owner}/${ref.repo}/pulls/${number}`,
		{ accept: "application/vnd.github.diff" },
	);
}

export interface ReviewComment {
	path: string;
	/** Line in the diff (right-side line number). */
	line: number;
	body: string;
}

interface RawReview {
	id: number;
	body: string | null;
	state: string;
}

/**
 * Find an existing review by marker, or submit a new COMMENT review.
 * The factory never approves and never requests changes.
 */
export async function ensureReview(
	http: GitHubHttp,
	ref: RepoRef,
	prNumber: number,
	opts: {
		commitId: string;
		body: string;
		comments: ReviewComment[];
		marker: string;
	},
): Promise<{ id: number; alreadyExisted: boolean }> {
	const existing = await http.send<RawReview[]>(
		"GET",
		`/repos/${ref.owner}/${ref.repo}/pulls/${prNumber}/reviews?per_page=100`,
	);
	const found = existing.find((r) => (r.body ?? "").includes(opts.marker));
	if (found) return { id: found.id, alreadyExisted: true };

	const body = redactSecrets(opts.body);
	const created = await http.send<RawReview>(
		"POST",
		`/repos/${ref.owner}/${ref.repo}/pulls/${prNumber}/reviews`,
		{
			body: {
				commit_id: opts.commitId,
				body: `${body}\n\n${opts.marker}`,
				event: "COMMENT",
				comments: opts.comments.map((c) => ({
					path: c.path,
					line: c.line,
					body: redactSecrets(c.body),
				})),
			},
		},
	);
	return { id: created.id, alreadyExisted: false };
}
