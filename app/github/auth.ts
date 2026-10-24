import { createSign } from "node:crypto";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type PermissionSet = Record<string, string>;

export interface GitHubTokenOptions {
	/** The installation that delivered the webhook. */
	installationId: number;
	/** Repository name without the owner; the token is restricted to this one repository. */
	repo: string;
	/** Omit for every permission the installation has. */
	permissions?: PermissionSet;
	fetch?: typeof fetch;
}

interface AppCredentials {
	appId: string;
	privateKey: string;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function githubApiUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
	return (env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
}

function appCredentials(): AppCredentials {
	const appId = process.env.GITHUB_APP_ID?.trim();
	const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
	if (!appId || !privateKey) throw new Error("GitHub App credentials required: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");
	return { appId, privateKey: normalizePrivateKey(privateKey) };
}

/**
 * Accepts the PEM as-is, with escaped newlines, or base64-encoded: env vars make real newlines awkward and
 * every deployment tool escapes them differently.
 */
export function normalizePrivateKey(value: string): string {
	if (value.includes("BEGIN")) return value.replace(/\\n/g, "\n");
	return Buffer.from(value, "base64").toString("utf8");
}

/** A JWT signed with the App's private key, valid for nine minutes (backdated one for clock skew). */
export function appJwt(credentials: AppCredentials = appCredentials()): string {
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: credentials.appId })).toString("base64url");
	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${payload}`);
	return `${header}.${payload}.${signer.sign(credentials.privateKey, "base64url")}`;
}

function cacheKey({ installationId, repo, permissions }: GitHubTokenOptions): string {
	const perms = permissions
		? Object.entries(permissions)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => `${k}:${v}`)
				.join(",")
		: "*";
	return `${installationId}/${repo}/${perms}`;
}

/**
 * Mints a GitHub App installation token restricted to one repository, cached per (installation, repository,
 * permissions) until five minutes before it expires.
 */
export async function githubToken(opts: GitHubTokenOptions): Promise<string> {
	const key = cacheKey(opts);
	const cached = tokenCache.get(key);
	if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;

	const credentials = appCredentials();
	const body: Record<string, unknown> = { repositories: [opts.repo] };
	if (opts.permissions) body.permissions = opts.permissions;
	const response = await (opts.fetch ?? fetch)(`${githubApiUrl()}/app/installations/${opts.installationId}/access_tokens`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${appJwt(credentials)}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "software-factory",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`GitHub App token exchange failed (${response.status}): ${text.slice(0, 300)}`);
	}
	const result = (await response.json()) as { token?: string; expires_at?: string };
	const expiresAt = Date.parse(result.expires_at ?? "");
	if (!result.token || Number.isNaN(expiresAt)) throw new Error("GitHub App token exchange returned no token or expiry");
	tokenCache.set(key, { token: result.token, expiresAt });
	return result.token;
}

/** Test seam. */
export function resetTokenCache(): void {
	tokenCache.clear();
}
