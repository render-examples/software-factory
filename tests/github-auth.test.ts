import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	githubToken,
	resetTokenCache,
	usingGitHubApp,
} from "../app/github/auth.js";

const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP_VARS = [
	"GITHUB_APP_ID",
	"GITHUB_APP_PRIVATE_KEY",
	"GITHUB_APP_INSTALLATION_ID",
	"GITHUB_TOKEN",
] as const;

function tokenResponse(token: string, expiresInMs: number) {
	return vi.fn(async () =>
		Response.json({
			token,
			expires_at: new Date(Date.now() + expiresInMs).toISOString(),
		}),
	) as unknown as typeof fetch;
}

function useApp(key = privateKey) {
	process.env.GITHUB_APP_ID = "123456";
	process.env.GITHUB_APP_PRIVATE_KEY = key;
	process.env.GITHUB_APP_INSTALLATION_ID = "7891011";
}

beforeEach(() => {
	resetTokenCache();
	for (const name of APP_VARS) delete process.env[name];
});

afterEach(() => {
	for (const name of APP_VARS) delete process.env[name];
});

describe("PAT fallback", () => {
	it("uses GITHUB_TOKEN when no app is configured", async () => {
		process.env.GITHUB_TOKEN = "ghp_personal";
		expect(await githubToken()).toBe("ghp_personal");
		expect(usingGitHubApp()).toBe(false);
	});

	it("throws when neither credential is present", async () => {
		await expect(githubToken()).rejects.toThrow(/No GitHub credentials/);
	});

	it("falls back to the PAT when the app config is incomplete", async () => {
		process.env.GITHUB_APP_ID = "123456";
		process.env.GITHUB_TOKEN = "ghp_personal";
		expect(await githubToken()).toBe("ghp_personal");
		expect(usingGitHubApp()).toBe(false);
	});
});

describe("GitHub App", () => {
	it("exchanges a signed JWT for an installation token", async () => {
		useApp();
		const fetchImpl = tokenResponse("ghs_install", 60 * 60 * 1000);

		expect(await githubToken(fetchImpl)).toBe("ghs_install");
		expect(usingGitHubApp()).toBe(true);

		const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
			.calls[0];
		expect(String(url)).toContain("/app/installations/7891011/access_tokens");
		expect((init as RequestInit).method).toBe("POST");

		// A JWT is three base64url segments; the app never sends the raw key.
		const auth = String(
			(init as RequestInit).headers &&
				((init as RequestInit).headers as Record<string, string>).Authorization,
		);
		expect(auth.replace("Bearer ", "").split(".")).toHaveLength(3);
		expect(auth).not.toContain("PRIVATE KEY");
	});

	it("prefers the app over a PAT when both are set", async () => {
		useApp();
		process.env.GITHUB_TOKEN = "ghp_personal";
		expect(await githubToken(tokenResponse("ghs_install", 3_600_000))).toBe(
			"ghs_install",
		);
	});

	it("caches the token instead of exchanging on every call", async () => {
		useApp();
		const fetchImpl = tokenResponse("ghs_install", 60 * 60 * 1000);

		await githubToken(fetchImpl);
		await githubToken(fetchImpl);
		await githubToken(fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	// A run can outlive the one-hour lifetime, so renew before it lapses.
	it("re-exchanges when the cached token is near expiry", async () => {
		useApp();
		const fetchImpl = tokenResponse("ghs_install", 60_000);

		await githubToken(fetchImpl);
		await githubToken(fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("accepts a base64-encoded private key", async () => {
		useApp(Buffer.from(privateKey).toString("base64"));
		expect(await githubToken(tokenResponse("ghs_install", 3_600_000))).toBe(
			"ghs_install",
		);
	});

	it("accepts a private key with escaped newlines", async () => {
		useApp(privateKey.replace(/\n/g, "\\n"));
		expect(await githubToken(tokenResponse("ghs_install", 3_600_000))).toBe(
			"ghs_install",
		);
	});

	it("surfaces an exchange failure", async () => {
		useApp();
		const fetchImpl = vi.fn(
			async () => new Response("bad installation", { status: 404 }),
		) as unknown as typeof fetch;

		await expect(githubToken(fetchImpl)).rejects.toThrow(
			/token exchange failed \(404\)/,
		);
	});
});
