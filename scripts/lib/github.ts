/** GitHub App access for the setup scripts and doctor, from injected env and fetch rather than process globals. */
import { createPrivateKey } from "node:crypto";
import { appJwt, normalizePrivateKey } from "../../app/github/auth.js";
import { GitHubHttp } from "../../app/github/request.js";
import { GitHubError } from "../../app/github/types.js";

export type Env = Readonly<Record<string, string | undefined>>;

export interface ScriptDeps {
	env: Env;
	fetch?: typeof fetch;
	/** Test seam: GitHubHttp's retry sleep. */
	sleep?: (ms: number) => Promise<void>;
}

export interface AppInfo {
	id: number;
	slug: string;
	name: string;
	html_url: string;
	owner: { login: string; type: string } | null;
	permissions: Record<string, string>;
	events: string[];
}

export interface HookConfig {
	url?: string;
	content_type?: string;
	insecure_ssl?: string | number;
	secret?: string;
}

export interface HookDelivery {
	id: number;
	delivered_at: string;
	status_code: number;
	event: string;
}

export interface Installation {
	id: number;
	permissions: Record<string, string>;
	events: string[];
}

export interface RepoLabel {
	name: string;
	color: string;
	description: string | null;
}

export function githubApiUrlFrom(env: Env): string {
	return (env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
}

/** github.com for the public API; for GitHub Enterprise Server, the host the `/api/v3` API is served from. */
export function githubWebUrl(apiUrl: string): string {
	const url = new URL(apiUrl);
	if (url.hostname === "api.github.com") return "https://github.com";
	return `${url.protocol}//${url.host}`;
}

/** Reads and validates the App credentials. Throws a message that never includes the key. */
export function appCredentialsFrom(env: Env): { appId: string; privateKey: string } {
	const appId = env.GITHUB_APP_ID?.trim();
	const raw = env.GITHUB_APP_PRIVATE_KEY?.trim();
	if (!appId || !raw) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required");
	if (!/^\d+$/.test(appId)) throw new Error("GITHUB_APP_ID must be the App's numeric ID");
	const privateKey = normalizePrivateKey(raw);
	try {
		createPrivateKey(privateKey);
	} catch {
		throw new Error("GITHUB_APP_PRIVATE_KEY does not parse as a PEM private key (raw, \\n-escaped, or base64)");
	}
	return { appId, privateKey };
}

/** Calls GitHub as the App (JWT) or as one of its installations. */
export class GitHubApp {
	readonly apiUrl: string;
	private readonly http: GitHubHttp;
	/** Installation tokens minted during this run, so callers can redact them. */
	readonly mintedTokens: string[] = [];

	constructor(private readonly deps: ScriptDeps) {
		const credentials = appCredentialsFrom(deps.env);
		this.apiUrl = githubApiUrlFrom(deps.env);
		this.http = this.client(() => appJwt(credentials));
	}

	getApp(): Promise<AppInfo> {
		return this.http.json<AppInfo>("GET", "/app");
	}

	getHookConfig(): Promise<HookConfig> {
		return this.http.json<HookConfig>("GET", "/app/hook/config");
	}

	updateHookConfig(body: HookConfig): Promise<HookConfig> {
		return this.http.json<HookConfig>("PATCH", "/app/hook/config", { body, idempotent: true });
	}

	/** The most recent deliveries, newest first. */
	recentDeliveries(perPage = 10): Promise<HookDelivery[]> {
		return this.http.json<HookDelivery[]>("GET", "/app/hook/deliveries", { query: { per_page: perPage } });
	}

	/** The App's installation on a repository, or null when it isn't installed there. */
	async repoInstallation(owner: string, repo: string): Promise<Installation | null> {
		try {
			return await this.http.json<Installation>(
				"GET",
				`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
			);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return null;
			throw error;
		}
	}

	/** An installation token restricted to one repository. */
	async installationToken(installationId: number, repo: string, permissions?: Record<string, string>): Promise<string> {
		const result = await this.http.json<{ token?: string }>("POST", `/app/installations/${installationId}/access_tokens`, {
			body: permissions ? { repositories: [repo], permissions } : { repositories: [repo] },
		});
		if (!result?.token) throw new Error("GitHub returned no installation token");
		this.mintedTokens.push(result.token);
		return result.token;
	}

	/** A client for one repository, authenticated with an installation token. */
	repo(owner: string, name: string, token: string): RepoClient {
		return new RepoClient(owner, name, this.client(() => token));
	}

	private client(token: () => string): GitHubHttp {
		return new GitHubHttp(token, { fetch: this.deps.fetch, apiUrl: this.apiUrl, sleep: this.deps.sleep });
	}
}

class RepoClient {
	private readonly base: string;

	constructor(
		readonly owner: string,
		readonly name: string,
		private readonly http: GitHubHttp,
	) {
		this.base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
	}

	listLabels(): Promise<RepoLabel[]> {
		return this.http.paginate<RepoLabel>(`${this.base}/labels`);
	}

	async createLabel(label: { name: string; color: string; description: string }): Promise<void> {
		await this.http.json("POST", `${this.base}/labels`, { body: label });
	}
}

/** Splits "owner/name". */
export function splitRepo(fullName: string): { owner: string; name: string } {
	const [owner, name, ...rest] = fullName.split("/");
	if (!owner || !name || rest.length > 0) throw new Error(`repository must be "owner/name", got "${fullName}"`);
	return { owner, name };
}
