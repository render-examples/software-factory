/** GitHub's wire shapes, mapped to our types at the edge of the client. */
import type { Issue, IssueComment, PullRequest } from "./types.js";

interface RawUser {
	login: string;
	type?: string;
}

export interface RawIssue {
	number: number;
	title: string;
	body: string | null;
	state: string;
	labels: ({ name: string } | string)[];
	user: RawUser | null;
	html_url: string;
}

export interface RawComment {
	id: number;
	body: string | null;
	user: RawUser | null;
	created_at: string;
}

export interface RawPull {
	number: number;
	html_url: string;
	head: { ref: string; sha: string };
}

export function toIssue(raw: RawIssue): Issue {
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? "",
		state: raw.state,
		labels: raw.labels.map((label) =>
			typeof label === "string" ? label : label.name,
		),
		user: raw.user?.login ?? "unknown",
		htmlUrl: raw.html_url,
	};
}

export function toComment(raw: RawComment): IssueComment {
	return {
		id: raw.id,
		body: raw.body ?? "",
		user: raw.user?.login ?? "unknown",
		authorType: raw.user?.type ?? "User",
		createdAt: raw.created_at,
	};
}

export function toPull(raw: RawPull): PullRequest {
	return { number: raw.number, htmlUrl: raw.html_url, headSha: raw.head.sha };
}
