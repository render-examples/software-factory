import { githubApiUrl } from "./auth.js";
import { GitHubError } from "./types.js";

/** Resolves the current token. Installation tokens expire, so it's called per request (githubToken caches). */
export type TokenProvider = () => string | Promise<string>;

export interface GitHubHttpOptions {
	fetch?: typeof fetch;
	/** Defaults to GITHUB_API_URL or https://api.github.com. */
	apiUrl?: string;
	timeoutMs?: number;
	/** Attempts per request, including the first. */
	maxAttempts?: number;
	/** Test seam. */
	sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
	body?: unknown;
	accept?: string;
	query?: Record<string, string | number | boolean | undefined>;
	/** POST and PATCH are retried only when set: the caller knows whether repeating the write is harmless. */
	idempotent?: boolean;
}

const DEFAULT_ACCEPT = "application/vnd.github+json";
/** A rate limit that asks for a longer wait fails instead: sleeping in a task is wasted compute. */
const MAX_WAIT_MS = 60_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

/** HTTP for the GitHub REST API: auth headers, JSON, timeouts, and retries on 5xx and rate limits. */
export class GitHubHttp {
	readonly apiUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly maxAttempts: number;
	private readonly sleep: (ms: number) => Promise<void>;
	/** Kept only to scrub it from error messages. */
	private lastToken = "";

	constructor(
		private readonly token: TokenProvider,
		opts: GitHubHttpOptions = {},
	) {
		this.apiUrl = (opts.apiUrl ?? githubApiUrl()).replace(/\/+$/, "");
		this.fetchImpl = opts.fetch ?? fetch;
		this.timeoutMs = opts.timeoutMs ?? 15_000;
		this.maxAttempts = opts.maxAttempts ?? 4;
		this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	/** JSON request; resolves undefined for 204. */
	async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
		const response = await this.send(method, path, opts);
		if (response.status === 204) return undefined as T;
		const text = await response.text();
		return (text ? JSON.parse(text) : undefined) as T;
	}

	/** Raw text response, for media types such as application/vnd.github.diff. */
	async text(method: string, path: string, opts: RequestOptions = {}): Promise<string> {
		return (await this.send(method, path, opts)).text();
	}

	/** Every page of a list endpoint, in API order, following Link rel="next". */
	async paginate<T>(path: string, opts: RequestOptions & { maxPages?: number } = {}): Promise<T[]> {
		const items: T[] = [];
		let next: string | null = path;
		let query: RequestOptions["query"] = { per_page: 100, ...opts.query };
		for (let page = 0; next; page++) {
			if (page >= (opts.maxPages ?? 30)) throw new Error(`GitHub GET ${path}: more than ${page} pages`);
			const response = await this.send("GET", next, { ...opts, query });
			items.push(...((await response.json()) as T[]));
			next = nextLink(response.headers.get("link"));
			// The next link carries the query.
			query = undefined;
		}
		return items;
	}

	async send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
		const url = this.url(path, opts.query);
		const retryable = SAFE_METHODS.has(method) || opts.idempotent === true;
		const attempts = retryable ? this.maxAttempts : 1;

		for (let attempt = 1; ; attempt++) {
			const token = await this.token();
			this.lastToken = token;
			let response: Response;
			try {
				response = await this.fetchImpl(url, {
					method,
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: opts.accept ?? DEFAULT_ACCEPT,
						"X-GitHub-Api-Version": "2022-11-28",
						"User-Agent": "software-factory",
						...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
					},
					body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
					signal: AbortSignal.timeout(this.timeoutMs),
				});
			} catch (error) {
				if (attempt >= attempts) throw error;
				await this.sleep(backoff(attempt));
				continue;
			}
			if (response.ok) return response;

			const body = await response.text().catch(() => "");
			const wait = retryDelay(response, body, attempt);
			if (wait !== null && attempt < attempts) {
				await this.sleep(wait);
				continue;
			}
			throw new GitHubError(
				response.status,
				this.redact(`GitHub ${method} ${pathOf(url)} -> ${response.status}: ${body.slice(0, 300)}`),
				this.redact(body),
			);
		}
	}

	private url(path: string, query: RequestOptions["query"]): string {
		let url: URL;
		if (/^https?:\/\//.test(path)) {
			// Only follow links back to the same API: a token must never leave for another host.
			if (!path.startsWith(`${this.apiUrl}/`)) throw new Error(`Refusing to send a GitHub token to ${new URL(path).host}`);
			url = new URL(path);
		} else {
			url = new URL(`${this.apiUrl}${path}`);
		}
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		return url.toString();
	}

	private redact(text: string): string {
		return this.lastToken ? text.split(this.lastToken).join("***") : text;
	}
}

/**
 * How long to wait before retrying, or null when the response isn't worth retrying. Retries 5xx, 429, and
 * rate-limited 403s (retry-after, x-ratelimit-remaining: 0, or a secondary rate limit message).
 */
function retryDelay(response: Response, body: string, attempt: number, now = Date.now()): number | null {
	const { status, headers } = response;
	const retryAfter = parseRetryAfter(headers.get("retry-after"), now);
	const exhausted = headers.get("x-ratelimit-remaining") === "0";
	const secondary = status === 403 && /secondary rate limit/i.test(body);
	const rateLimited = status === 429 || (status === 403 && (retryAfter !== null || exhausted || secondary));
	if (!rateLimited && status < 500) return null;

	let wait: number;
	if (retryAfter !== null) wait = retryAfter;
	else if (exhausted && headers.get("x-ratelimit-reset")) wait = Number(headers.get("x-ratelimit-reset")) * 1000 - now;
	// GitHub asks for at least a minute after a secondary limit that names no wait.
	else if (secondary) wait = MAX_WAIT_MS;
	else wait = backoff(attempt);
	if (!Number.isFinite(wait) || wait > MAX_WAIT_MS) return null;
	return Math.max(wait, 0);
}

/** retry-after is delta-seconds or an HTTP date. */
function parseRetryAfter(value: string | null, now: number): number | null {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1000;
	const date = Date.parse(value);
	return Number.isNaN(date) ? null : Math.max(date - now, 0);
}

function backoff(attempt: number): number {
	return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

function nextLink(header: string | null): string | null {
	if (!header) return null;
	for (const part of header.split(",")) {
		const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
		if (match?.[1]) return match[1];
	}
	return null;
}

function pathOf(url: string): string {
	return new URL(url).pathname;
}

/** Encodes each segment of a git ref or file path, so `release/2.x` stays two segments. */
export function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}
