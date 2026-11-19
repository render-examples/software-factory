export const PERMISSIONS = ["none", "read", "triage", "write", "maintain", "admin"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface Actor {
	login: string;
	type: string;
}

export interface Issue {
	number: number;
	title: string;
	body: string;
	state: string;
	labels: string[];
	author: Actor;
	isPull: boolean;
	htmlUrl: string;
}

export interface IssueComment {
	id: number;
	body: string;
	author: Actor;
	createdAt: string;
	updatedAt: string;
	htmlUrl: string;
}

export interface LabelEvent {
	label: string;
	createdAt: string;
	actor: Actor | null;
}

export interface PullRequest {
	number: number;
	state: string;
	merged: boolean;
	title: string;
	body: string;
	headSha: string;
	headRef: string;
	baseRef: string;
	htmlUrl: string;
}

export interface PullFile {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	changes: number;
	patch?: string;
	previousFilename?: string;
}

export interface ReviewComment {
	path: string;
	line: number;
	side: "LEFT" | "RIGHT";
	body: string;
}

export interface PullRequestReview {
	id: number;
	body: string;
	author: Actor;
	commitId: string;
	state: string;
	htmlUrl: string;
}

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly body: string = "",
	) {
		super(message);
		this.name = "GitHubError";
	}
}
