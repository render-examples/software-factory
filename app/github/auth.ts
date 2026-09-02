import { createSign } from "node:crypto";

/**
 * Two ways to authenticate, chosen by which variables are set.
 *
 * A GitHub App is preferred: work is attributed to the app rather than to a
 * maintainer, and installation tokens expire after an hour. A fine-grained PAT
 * in GITHUB_TOKEN is the fallback, which is quicker to set up but makes every
 * comment and pull request look like it came from the token's owner.
 */

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface AppCredentials {
	appId: string;
	privateKey: string;
	installationId: string;
}

let cached: { token: string; expiresAt: number } | undefined;

function appCredentials(): AppCredentials | null {
	const appId = process.env.GITHUB_APP_ID?.trim();
	const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
	const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
	if (!appId || !privateKey || !installationId) return null;
	return { appId, privateKey: normalizePrivateKey(privateKey), installationId };
}

/**
 * Accept the PEM as-is, with escaped newlines, or base64-encoded — env vars
 * make real newlines awkward and every deployment tool escapes them
 * differently.
 */
function normalizePrivateKey(value: string): string {
	if (value.includes("BEGIN")) return value.replace(/\\n/g, "\n");
	return Buffer.from(value, "base64").toString("utf8");
}

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

/** Short-lived JWT proving we hold the app's private key. */
function appJwt({ appId, privateKey }: AppCredentials): string {
	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	// Backdated for clock skew; GitHub rejects an exp more than 10 minutes out.
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
): Promise<{ token: string; expiresAt: number }> {
	const response = await fetchImpl(
		`${API}/app/installations/${credentials.installationId}/access_tokens`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${appJwt(credentials)}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "render-factory",
			},
			signal: AbortSignal.timeout(15_000),
		},
	);

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`GitHub App token exchange failed (${response.status}): ${body.slice(0, 300)}`,
		);
	}

	const body = (await response.json()) as { token: string; expires_at: string };
	return { token: body.token, expiresAt: Date.parse(body.expires_at) };
}

/**
 * The token to authenticate with. Installation tokens are cached and renewed
 * before they expire, because a run can outlive the one-hour lifetime.
 */
export async function githubToken(
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	const credentials = appCredentials();

	if (!credentials) {
		const pat = process.env.GITHUB_TOKEN?.trim();
		if (!pat) {
			throw new Error(
				"No GitHub credentials. Set GITHUB_TOKEN, or GITHUB_APP_ID, " +
					"GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID.",
			);
		}
		return pat;
	}

	if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
		return cached.token;
	}
	cached = await installationToken(credentials, fetchImpl);
	return cached.token;
}

/** True when the factory acts as a GitHub App rather than a user. */
export function usingGitHubApp(): boolean {
	return appCredentials() !== null;
}

/** Test seam. */
export function resetTokenCache(): void {
	cached = undefined;
}
