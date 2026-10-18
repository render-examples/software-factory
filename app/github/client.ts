import type { RepoContext } from "../config/index.js";
import { appJwt, githubToken } from "./auth.js";
import { encodePath, GitHubHttp, type GitHubHttpOptions, type TokenProvider } from "./request.js";
import {
	type Actor,
	GitHubError,
	type Issue,
	type IssueComment,
	type LabelEvent,
	PERMISSIONS,
	type Permission,
	type PullFile,
	type PullRequest,
	type Review,
	type ReviewComment,
} from "./types.js";

export interface GitHubForOptions extends GitHubHttpOptions {
	/** Overrides the installation token, for tests and scripts. */
	token?: TokenProvider;
}

/** A GitHub client for one repository, acting as the App installation that delivered the webhook. */
export function githubFor(
	repo: Pick<RepoContext, "owner" | "name" | "installationId">,
	opts: GitHubForOptions = {},
): GitHubClient {
	const token = opts.token ?? (() => githubToken({ installationId: repo.installationId, repo: repo.name, fetch: opts.fetch }));
	return new GitHubClient(repo.owner, repo.name, new GitHubHttp(token, opts), opts);
}

const botLogins = new Map<string, Promise<string>>();

/** Test seam. */
export function resetBotLoginCache(): void {
	botLogins.clear();
}

/** Workflow-owned GitHub operations. Agents never get this. */
export class GitHubClient {
	private readonly base: string;

	constructor(
		readonly owner: string,
		readonly repo: string,
		readonly http: GitHubHttp,
		private readonly opts: GitHubHttpOptions = {},
	) {
		this.base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	}

	/** The App's bot login, `<app-slug>[bot]`, from GET /app with the App JWT. Cached per process. */
	botLogin(): Promise<string> {
		const key = this.http.apiUrl;
		let login = botLogins.get(key);
		if (!login) {
			const appHttp = new GitHubHttp(() => appJwt(), { ...this.opts, apiUrl: this.http.apiUrl });
			login = appHttp.json<{ slug: string }>("GET", "/app").then((app) => `${app.slug}[bot]`);
			login.catch(() => botLogins.delete(key));
			botLogins.set(key, login);
		}
		return login;
	}

	async getIssue(number: number): Promise<Issue> {
		return toIssue(await this.http.json<RawIssue>("GET", `${this.base}/issues/${number}`));
	}

	/** Every comment, oldest first. */
	async listIssueComments(number: number): Promise<IssueComment[]> {
		return (await this.http.paginate<RawComment>(`${this.base}/issues/${number}/comments`)).map(toComment);
	}

	async createComment(number: number, body: string): Promise<IssueComment> {
		return toComment(await this.http.json<RawComment>("POST", `${this.base}/issues/${number}/comments`, { body: { body } }));
	}

	async updateComment(commentId: number, body: string): Promise<IssueComment> {
		return toComment(
			await this.http.json<RawComment>("PATCH", `${this.base}/issues/comments/${commentId}`, {
				body: { body },
				idempotent: true,
			}),
		);
	}

	/** Creates a repository label; an existing one (422) is left as it is. */
	async ensureLabel(name: string, color: string, description = ""): Promise<void> {
		try {
			await this.http.json("POST", `${this.base}/labels`, { body: { name, color, description } });
		} catch (error) {
			if (error instanceof GitHubError && error.status === 422) return;
			throw error;
		}
	}

	async addLabels(number: number, labels: readonly string[]): Promise<void> {
		if (labels.length === 0) return;
		await this.http.json("POST", `${this.base}/issues/${number}/labels`, { body: { labels }, idempotent: true });
	}

	/** A label that isn't on the issue (404) is fine. */
	async removeLabel(number: number, label: string): Promise<void> {
		try {
			await this.http.json("DELETE", `${this.base}/issues/${number}/labels/${encodeURIComponent(label)}`);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return;
			throw error;
		}
	}

	/**
	 * The user's repository permission. `permission` folds maintain into write and triage into read, so this reads
	 * `role_name`, and for custom roles the permission flags. A non-collaborator (404) has "none".
	 */
	async getPermission(login: string): Promise<Permission> {
		try {
			const raw = await this.http.json<RawPermission>(
				"GET",
				`${this.base}/collaborators/${encodeURIComponent(login)}/permission`,
			);
			return toPermission(raw);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return "none";
			throw error;
		}
	}

	/** Times a label was applied to the issue or PR, oldest first. */
	async getLabelEvents(number: number, label: string): Promise<LabelEvent[]> {
		const events = await this.http.paginate<RawIssueEvent>(`${this.base}/issues/${number}/events`);
		return events
			.filter((event) => event.event === "labeled" && event.label?.name === label)
			.map((event) => ({ label, createdAt: event.created_at, actor: event.actor ? toActor(event.actor) : null }));
	}

	async getPull(number: number): Promise<PullRequest> {
		return toPull(await this.http.json<RawPull>("GET", `${this.base}/pulls/${number}`));
	}

	/** The PR's unified diff. */
	async getPullDiff(number: number): Promise<string> {
		return this.http.text("GET", `${this.base}/pulls/${number}`, { accept: "application/vnd.github.diff" });
	}

	async listPullFiles(number: number): Promise<PullFile[]> {
		const files = await this.http.paginate<RawPullFile>(`${this.base}/pulls/${number}/files`);
		return files.map((file) => ({
			filename: file.filename,
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
			changes: file.changes,
			...(file.patch === undefined ? {} : { patch: file.patch }),
			...(file.previous_filename === undefined ? {} : { previousFilename: file.previous_filename }),
		}));
	}

	async listReviews(pr: number): Promise<Review[]> {
		return (await this.http.paginate<RawReview>(`${this.base}/pulls/${pr}/reviews`)).map(toReview);
	}

	/** Posts a COMMENT review. The type admits no other event: the factory never approves or requests changes. */
	async createReview(
		pr: number,
		review: { commitId: string; body: string; event: "COMMENT"; comments: ReviewComment[] },
	): Promise<Review> {
		return toReview(
			await this.http.json<RawReview>("POST", `${this.base}/pulls/${pr}/reviews`, {
				body: { commit_id: review.commitId, body: review.body, event: "COMMENT", comments: review.comments },
			}),
		);
	}

	/** The open PR from `head`, or a new one. Safe to repeat: a replayed run finds the PR the first one opened. */
	async findOrCreatePull(args: {
		head: string;
		base: string;
		title: string;
		body: string;
		draft?: boolean;
	}): Promise<{ pull: PullRequest; created: boolean }> {
		const existing = await this.findOpenPull(args.head);
		if (existing) return { pull: existing, created: false };
		try {
			const raw = await this.http.json<RawPull>("POST", `${this.base}/pulls`, {
				body: { head: args.head, base: args.base, title: args.title, body: args.body, draft: args.draft ?? true },
			});
			return { pull: toPull(raw), created: true };
		} catch (error) {
			// Lost a race with another run, or a retried POST that had succeeded.
			if (error instanceof GitHubError && error.status === 422) {
				const raced = await this.findOpenPull(args.head);
				if (raced) return { pull: raced, created: false };
			}
			throw error;
		}
	}

	/** A branch's tip commit, or null when the branch doesn't exist. */
	async getBranchSha(branch: string): Promise<string | null> {
		try {
			const ref = await this.http.json<{ object: { sha: string } }>("GET", `${this.base}/git/ref/heads/${encodePath(branch)}`);
			return ref.object.sha;
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return null;
			throw error;
		}
	}

	private async findOpenPull(head: string): Promise<PullRequest | null> {
		const open = await this.http.json<RawPull[]>("GET", `${this.base}/pulls`, {
			query: { head: `${this.owner}:${head}`, state: "open", per_page: 10 },
		});
		return open[0] ? toPull(open[0]) : null;
	}
}

interface RawUser {
	login: string;
	type: string;
}

interface RawIssue {
	number: number;
	title: string;
	body: string | null;
	state: string;
	labels: (string | { name?: string })[];
	user: RawUser | null;
	pull_request?: unknown;
	html_url: string;
}

interface RawComment {
	id: number;
	body?: string | null;
	user: RawUser | null;
	performed_via_github_app?: { slug?: string } | null;
	created_at: string;
	updated_at: string;
	html_url: string;
}

interface RawPermission {
	permission: string;
	role_name?: string;
	user?: { permissions?: Partial<Record<"admin" | "maintain" | "push" | "triage" | "pull", boolean>> } | null;
}

interface RawIssueEvent {
	event: string;
	created_at: string;
	actor: RawUser | null;
	label?: { name: string };
}

interface RawPull {
	number: number;
	state: string;
	draft?: boolean;
	merged?: boolean;
	title: string;
	body: string | null;
	head: { sha: string; ref: string; repo: { full_name: string } | null };
	base: { sha: string; ref: string };
	html_url: string;
}

interface RawPullFile {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	changes: number;
	patch?: string;
	previous_filename?: string;
}

interface RawReview {
	id: number;
	body: string | null;
	user: RawUser | null;
	commit_id: string;
	state: string;
	html_url: string;
}

const GHOST: Actor = { login: "ghost", type: "User" };

function toActor(user: RawUser | null): Actor {
	return user ? { login: user.login, type: user.type } : GHOST;
}

function toIssue(raw: RawIssue): Issue {
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? "",
		state: raw.state,
		labels: raw.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean),
		author: toActor(raw.user),
		isPull: raw.pull_request !== undefined,
		htmlUrl: raw.html_url,
	};
}

function toComment(raw: RawComment): IssueComment {
	return {
		id: raw.id,
		body: raw.body ?? "",
		author: toActor(raw.user),
		performedViaApp: raw.performed_via_github_app?.slug ?? null,
		createdAt: raw.created_at,
		updatedAt: raw.updated_at,
		htmlUrl: raw.html_url,
	};
}

function toPermission(raw: RawPermission): Permission {
	if ((PERMISSIONS as readonly string[]).includes(raw.role_name ?? "")) return raw.role_name as Permission;
	const flags = raw.user?.permissions;
	if (flags) {
		if (flags.admin) return "admin";
		if (flags.maintain) return "maintain";
		if (flags.push) return "write";
		if (flags.triage) return "triage";
		if (flags.pull) return "read";
	}
	return (PERMISSIONS as readonly string[]).includes(raw.permission) ? (raw.permission as Permission) : "none";
}

function toPull(raw: RawPull): PullRequest {
	return {
		number: raw.number,
		state: raw.state,
		draft: raw.draft ?? false,
		merged: raw.merged ?? false,
		title: raw.title,
		body: raw.body ?? "",
		headSha: raw.head.sha,
		headRef: raw.head.ref,
		headRepo: raw.head.repo?.full_name ?? null,
		baseRef: raw.base.ref,
		baseSha: raw.base.sha,
		htmlUrl: raw.html_url,
	};
}

function toReview(raw: RawReview): Review {
	return {
		id: raw.id,
		body: raw.body ?? "",
		author: toActor(raw.user),
		commitId: raw.commit_id,
		state: raw.state,
		htmlUrl: raw.html_url,
	};
}
