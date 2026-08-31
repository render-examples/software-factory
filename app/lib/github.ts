// GitHub REST client for workflow side-effects (issues, PRs, reviews).
// Lives in lib/ (not tools/) so writes happen under workflow control,
// not as model-callable tools. Auth: fine-grained PAT via GITHUB_TOKEN.

const DEFAULT_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_GET_ATTEMPTS = 3;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
	createdAt: string;
}

export interface PullRequest {
	number: number;
	title: string;
	body: string;
	htmlUrl: string;
	head: string;
	headSha: string;
	base: string;
	state: string;
	user: string;
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

interface RequestOptions {
	body?: unknown;
	accept?: string;
}

export class GitHub {
	private readonly api: string;

	constructor(
		private readonly token: string,
		private readonly fetchImpl: typeof fetch = fetch,
		api = process.env.GITHUB_API_URL ?? DEFAULT_API,
	) {
		this.api = api.replace(/\/$/, "");
	}

	private redact(s: string): string {
		return this.token ? s.split(this.token).join("***") : s;
	}

	private async request<T>(
		method: string,
		path: string,
		opts: RequestOptions = {},
	): Promise<T> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			Accept: opts.accept ?? "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "render-factory-demo",
		};
		if (opts.body !== undefined) headers["Content-Type"] = "application/json";

		let res: Response | undefined;
		let lastError: unknown;
		const attempts = method === "GET" ? MAX_GET_ATTEMPTS : 1;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				res = await this.fetchImpl(`${this.api}${path}`, {
					method,
					headers,
					body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				if (attempt < attempts && (res.status === 429 || res.status >= 500)) {
					const retryAfter = Number(res.headers.get("retry-after"));
					await res.body?.cancel();
					await sleep(
						Number.isFinite(retryAfter) && retryAfter > 0
							? Math.min(retryAfter * 1000, 5_000)
							: 250 * attempt,
					);
					continue;
				}
				break;
			} catch (error) {
				lastError = error;
				if (attempt === attempts) throw error;
				await sleep(250 * attempt);
			}
		}
		if (!res) throw lastError ?? new Error("GitHub request failed");

		if (!res.ok) {
			const text = await readResponseText(res, MAX_ERROR_BYTES).catch(() => "");
			throw new GitHubError(
				res.status,
				this.redact(
					`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`,
				),
				text,
			);
		}
		if (res.status === 204) return undefined as T;
		const text = await readResponseText(res, MAX_RESPONSE_BYTES);
		const accept = opts.accept ?? "";
		if (accept.includes("diff") || accept.includes("raw")) {
			return text as T;
		}
		return JSON.parse(text) as T;
	}

	// --- Issues ---

	async getIssue(ref: RepoRef, number: number): Promise<Issue> {
		const raw = await this.request<RawIssue>(
			"GET",
			`/repos/${ref.owner}/${ref.repo}/issues/${number}`,
		);
		return toIssue(raw);
	}

	async listIssueComments(
		ref: RepoRef,
		number: number,
	): Promise<IssueComment[]> {
		const raw: RawComment[] = [];
		for (let page = 1; page <= 10; page++) {
			const batch = await this.request<RawComment[]>(
				"GET",
				`/repos/${ref.owner}/${ref.repo}/issues/${number}/comments?per_page=100&page=${page}`,
			);
			raw.push(...batch);
			if (batch.length < 100) break;
			if (page === 10) {
				throw new Error("Issue has more than 1,000 comments");
			}
		}
		return raw.map((c) => ({
			id: c.id,
			body: c.body ?? "",
			user: c.user?.login ?? "unknown",
			createdAt: c.created_at,
		}));
	}

	async createIssueComment(
		ref: RepoRef,
		number: number,
		body: string,
	): Promise<void> {
		await this.request(
			"POST",
			`/repos/${ref.owner}/${ref.repo}/issues/${number}/comments`,
			{ body: { body } },
		);
	}

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
		await this.createIssueComment(ref, number, `${body}\n\n${marker}`);
	}

	async addLabels(
		ref: RepoRef,
		number: number,
		labels: string[],
	): Promise<void> {
		if (labels.length === 0) return;
		await this.request(
			"POST",
			`/repos/${ref.owner}/${ref.repo}/issues/${number}/labels`,
			{ body: { labels } },
		);
	}

	/** Remove a label. A 404 (already absent) is treated as success. */
	async removeLabel(
		ref: RepoRef,
		number: number,
		label: string,
	): Promise<void> {
		try {
			await this.request(
				"DELETE",
				`/repos/${ref.owner}/${ref.repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
			);
		} catch (err) {
			if (err instanceof GitHubError && err.status === 404) return;
			throw err;
		}
	}

	// --- Pull requests ---

	async findOpenPullByHead(
		ref: RepoRef,
		branch: string,
	): Promise<PullRequest | null> {
		const raw = await this.request<RawPull[]>(
			"GET",
			`/repos/${ref.owner}/${ref.repo}/pulls?head=${ref.owner}:${encodeURIComponent(branch)}&state=open`,
		);
		return raw.length > 0 ? toPull(raw[0]) : null;
	}

	async createPull(
		ref: RepoRef,
		args: {
			title: string;
			head: string;
			base: string;
			body: string;
			draft: true;
		},
	): Promise<PullRequest> {
		const raw = await this.request<RawPull>(
			"POST",
			`/repos/${ref.owner}/${ref.repo}/pulls`,
			{ body: args },
		);
		return toPull(raw);
	}

	/** Reuse an existing open PR for the same head branch, or create one. */
	async ensurePull(
		ref: RepoRef,
		args: {
			title: string;
			head: string;
			base: string;
			body: string;
			draft: true;
			expectedHeadSha: string;
		},
	): Promise<PullRequest> {
		const existing = await this.findOpenPullByHead(ref, args.head);
		if (existing) {
			if (existing.headSha !== args.expectedHeadSha) {
				throw new Error(
					"Existing pull request head does not match reviewed SHA",
				);
			}
			return existing;
		}
		const { expectedHeadSha: _, ...createArgs } = args;
		return this.createPull(ref, createArgs);
	}
}

/** Build a client from GITHUB_TOKEN. Throws if unset. */
export function githubFromEnv(fetchImpl: typeof fetch = fetch): GitHub {
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		throw new Error(
			"GITHUB_TOKEN is not set — a fine-grained PAT is required.",
		);
	}
	return new GitHub(token, fetchImpl);
}

// --- raw payload shapes + mappers ---

interface RawUser {
	login: string;
}
interface RawLabel {
	name: string;
}
interface RawIssue {
	number: number;
	title: string;
	body: string | null;
	state: string;
	labels: (RawLabel | string)[];
	user: RawUser | null;
	html_url: string;
}
interface RawComment {
	id: number;
	body: string | null;
	user: RawUser | null;
	created_at: string;
}
interface RawPull {
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	head: { ref: string; sha: string };
	base: { ref: string };
	state: string;
	user: RawUser | null;
}

function toIssue(raw: RawIssue): Issue {
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? "",
		state: raw.state,
		labels: raw.labels.map((l) => (typeof l === "string" ? l : l.name)),
		user: raw.user?.login ?? "unknown",
		htmlUrl: raw.html_url,
	};
}

function toPull(raw: RawPull): PullRequest {
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? "",
		htmlUrl: raw.html_url,
		head: raw.head.ref,
		headSha: raw.head.sha,
		base: raw.base.ref,
		state: raw.state,
		user: raw.user?.login ?? "unknown",
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponseText(
	response: Response,
	maxBytes: number,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			throw new Error(`GitHub response exceeded ${maxBytes} bytes`);
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks, totalBytes).toString("utf8");
}
