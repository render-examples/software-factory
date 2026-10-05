import { createSign } from "node:crypto";
import { repository } from "../config/index.js";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface AppCredentials {
	appId: string;
	privateKey: string;
	installationId: string;
}

export type PermissionSet = Record<string, string>;

export interface GitHubTokenOptions {
	permissions?: PermissionSet;
	fetch?: typeof fetch;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function appCredentials(): AppCredentials {
	const appId = process.env.GITHUB_APP_ID?.trim();
	const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
	const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
	if (!appId || !privateKey || !installationId) {
		throw new Error(
			"GitHub App credentials required. Set GITHUB_APP_ID, " +
				"GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID.",
		);
	}
	return {
		appId,
		privateKey: normalizePrivateKey(privateKey),
		installationId,
	};
}

/**
 * Accept the PEM as-is, with escaped newlines, or base64-encoded — env
 * vars make real newlines awkward and every deployment tool escapes them
 * differently.
 */
function normalizePrivateKey(value: string): string {
	if (value.includes("BEGIN")) return value.replace(/\\n/g, "\n");
	return Buffer.from(value, "base64").toString("utf8");
}

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

function appJwt({ appId, privateKey }: AppCredentials): string {
	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
	);

	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${payload}`);
	return `${header}.${payload}.${signer.sign(privateKey, "base64url")}`;
}

async function installationToken(
	credentials: AppCredentials,
	fetchImpl: typeof fetch,
	options?: { permissions?: PermissionSet },
): Promise<{ token: string; expiresAt: number }> {
	const repo = repository();
	const body: Record<string, unknown> = {
		repositories: [repo.repo],
	};
	if (options?.permissions) {
		body.permissions = options.permissions;
	}

	const response = await fetchImpl(
		`${API}/app/installations/${credentials.installationId}/access_tokens`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${appJwt(credentials)}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "render-factory",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		},
	);

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`GitHub App token exchange failed (${response.status}): ${text.slice(0, 300)}`,
		);
	}

	const result = (await response.json()) as {
		token: string;
		expires_at: string;
	};
	return {
		token: result.token,
		expiresAt: Date.parse(result.expires_at),
	};
}

function cacheKey(permissions?: PermissionSet): string {
	if (!permissions) return "__default__";
	return Object.entries(permissions)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}:${v}`)
		.join(",");
}

/**
 * Mint a GitHub installation token scoped to the target repository.
 * Tokens are cached per permission set and renewed before expiry.
 */
export async function githubToken(
	opts: GitHubTokenOptions = {},
): Promise<string> {
	const fetchImpl = opts.fetch ?? fetch;
	const { permissions } = opts;

	const credentials = appCredentials();
	const key = cacheKey(permissions);
	const cached = tokenCache.get(key);

	if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
		return cached.token;
	}

	const result = await installationToken(credentials, fetchImpl, {
		permissions,
	});
	tokenCache.set(key, result);
	return result.token;
}

/** Test seam. */
export function resetTokenCache(): void {
	tokenCache.clear();
}
