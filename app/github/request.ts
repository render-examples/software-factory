import { GitHubError } from "./types.js";

const DEFAULT_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_GET_ATTEMPTS = 3;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Resolves the current token. App installation tokens expire and rotate. */
export type TokenProvider = () => string | Promise<string>;

/** HTTP layer: auth headers, timeouts, retries on 429/5xx, size caps. */
export class GitHubHttp {
	private readonly api: string;
	/** Last token seen, kept only so it can be scrubbed from error messages. */
	private lastToken = "";

	constructor(
		private readonly token: TokenProvider,
		private readonly fetchImpl: typeof fetch = fetch,
		api = process.env.GITHUB_API_URL ?? DEFAULT_API,
	) {
		this.api = api.replace(/\/$/, "");
	}

	redact(text: string): string {
		return this.lastToken ? text.split(this.lastToken).join("***") : text;
	}

	async send<T>(
		method: string,
		path: string,
		opts: { body?: unknown } = {},
	): Promise<T> {
		const token = await this.token();
		this.lastToken = token;

		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "render-factory",
		};
		if (opts.body !== undefined) headers["Content-Type"] = "application/json";

		let response: Response | undefined;
		let lastError: unknown;
		const attempts = method === "GET" ? MAX_GET_ATTEMPTS : 1;

		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				response = await this.fetchImpl(`${this.api}${path}`, {
					method,
					headers,
					body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				if (
					attempt < attempts &&
					(response.status === 429 || response.status >= 500)
				) {
					const retryAfter = Number(response.headers.get("retry-after"));
					await response.body?.cancel();
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
		if (!response) throw lastError ?? new Error("GitHub request failed");

		if (!response.ok) {
			const text = await readResponseText(response, MAX_ERROR_BYTES).catch(
				() => "",
			);
			throw new GitHubError(
				response.status,
				this.redact(
					`GitHub ${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`,
				),
				text,
			);
		}
		if (response.status === 204) return undefined as T;
		return JSON.parse(
			await readResponseText(response, MAX_RESPONSE_BYTES),
		) as T;
	}
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
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`GitHub response exceeded ${maxBytes} bytes`);
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks, total).toString("utf8");
}
