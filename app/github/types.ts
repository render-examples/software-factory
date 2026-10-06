export interface RepoRef {
	owner: string;
	repo: string;
}

export interface Issue {
	number: number;
	title: string;
	body: string;
	state: string;
	labels: string[];
	user: string;
	htmlUrl: string;
}

export interface IssueComment {
	id: number;
	body: string;
	user: string;
	/** "User", "Bot", "Organization", etc. — from `user.type` in the API. */
	authorType: string;
	createdAt: string;
}

export interface PullRequest {
	number: number;
	htmlUrl: string;
	headSha: string;
}

/** Enough of the repository to reason about it without a checkout. */
export interface RepoSnapshot {
	defaultBranch: string;
	/** Repository paths, filtered and capped. */
	paths: string[];
	/** True when the tree was cut short, by GitHub or by us. */
	truncated: boolean;
	files: { path: string; content: string }[];
}

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly body?: string,
	) {
		super(message);
		this.name = "GitHubError";
	}
}
