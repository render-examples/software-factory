import { createPrivateKey } from "node:crypto";
import { z } from "zod";
import { appJwt, GitHubError, GitHubHttp, githubApiUrl, normalizePrivateKey } from "../../app/github/index.js";

export type Env = Readonly<Record<string, string | undefined>>;

export interface ScriptDeps {
	env: Env;
	fetch?: typeof fetch;
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

const hookDelivery = z.object({
	id: z.string().regex(/^[1-9]\d*$/),
	delivered_at: z.iso.datetime(),
	status_code: z.number().int().min(0).max(599),
	event: z.string().min(1).max(100),
});

export type HookDelivery = z.infer<typeof hookDelivery>;

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

export function githubWebUrl(apiUrl: string): string {
	const url = new URL(apiUrl);
	if (url.hostname === "api.github.com") return "https://github.com";
	return `${url.protocol}//${url.host}`;
}

function parseWithExactIds(text: string): unknown {
	if (!text) return undefined;
	return JSON.parse(text, (key, value, context?: { source?: string }) =>
		key === "id" && typeof value === "number" && context?.source ? context.source : value,
	);
}

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

export class GitHubApp {
	readonly apiUrl: string;
	private readonly http: GitHubHttp;
	readonly mintedTokens: string[] = [];

	constructor(private readonly deps: ScriptDeps) {
		const credentials = appCredentialsFrom(deps.env);
		this.apiUrl = githubApiUrl(deps.env);
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

	async recentDeliveries(perPage = 10): Promise<HookDelivery[]> {
		const response = parseWithExactIds(await this.http.text("GET", "/app/hook/deliveries", { query: { per_page: perPage } }));
		const result = z.array(hookDelivery).max(100).safeParse(response);
		if (!result.success) throw new Error("GitHub returned an invalid webhook delivery list");
		return result.data;
	}

	async hookDelivery(id: string): Promise<HookDelivery & { url: string }> {
		const response = parseWithExactIds(await this.http.text("GET", `/app/hook/deliveries/${id}`));
		const result = hookDelivery.extend({ url: z.url() }).safeParse(response);
		if (!result.success) throw new Error("GitHub returned invalid webhook delivery metadata");
		return result.data;
	}

	async repoInstallation(owner: string, repo: string): Promise<Installation | null> {
		try {
			return await this.http.json<Installation>("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return null;
			throw error;
		}
	}

	async installationToken(installationId: number, repo: string, permissions?: Record<string, string>): Promise<string> {
		const result = await this.http.json<{ token?: string }>("POST", `/app/installations/${installationId}/access_tokens`, {
			body: permissions ? { repositories: [repo], permissions } : { repositories: [repo] },
		});
		if (!result?.token) throw new Error("GitHub returned no installation token");
		this.mintedTokens.push(result.token);
		return result.token;
	}

	repo(owner: string, name: string, token: string): RepoClient {
		return new RepoClient(
			owner,
			name,
			this.client(() => token),
		);
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

	metadata(): Promise<unknown> {
		return this.http.json("GET", this.base);
	}

	branch(name: string): Promise<unknown> {
		return this.http.json("GET", `${this.base}/branches/${encodeURIComponent(name)}`);
	}

	async createLabel(label: { name: string; color: string; description: string }): Promise<void> {
		await this.http.json("POST", `${this.base}/labels`, { body: label });
	}
}

export function splitRepo(fullName: string): { owner: string; name: string } {
	const [owner, name, ...rest] = fullName.split("/");
	if (!owner || !name || rest.length > 0) throw new Error(`repository must be "owner/name", got "${fullName}"`);
	return { owner, name };
}
