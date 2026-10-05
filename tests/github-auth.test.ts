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

describe("App-only auth", () => {
	it("throws when no app credentials are present", async () => {
		await expect(githubToken()).rejects.toThrow(/GitHub App credentials required/);
	});

	it("throws when app config is incomplete", async () => {
		process.env.GITHUB_APP_ID = "123456";
		await expect(githubToken()).rejects.toThrow(/GitHub App credentials required/);
	});

	it("usingGitHubApp always returns true", () => {
		expect(usingGitHubApp()).toBe(true);
	});
});

describe("GitHub App", () => {
	it("exchanges a signed JWT for an installation token", async () => {
		useApp();
		const fetchImpl = tokenResponse("ghs_install", 60 * 60 * 1000);

		expect(await githubToken(fetchImpl)).toBe("ghs_install");

		const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
			.calls[0];
		expect(String(url)).toContain("/app/installations/7891011/access_tokens");
		expect((init as RequestInit).method).toBe("POST");

		const auth = String(
			(init as RequestInit).headers &&
				((init as RequestInit).headers as Record<string, string>).Authorization,
		);
		expect(auth.replace("Bearer ", "").split(".")).toHaveLength(3);
		expect(auth).not.toContain("PRIVATE KEY");
	});

	it("scopes tokens to the target repository", async () => {
		useApp();
		const fetchImpl = tokenResponse("ghs_scoped", 3_600_000);
		await githubToken(fetchImpl);

		const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body.repositories).toContain("render-factory-sample");
	});

	it("caches the token instead of exchanging on every call", async () => {
		useApp();
		const fetchImpl = tokenResponse("ghs_install", 60 * 60 * 1000);

		await githubToken(fetchImpl);
		await githubToken(fetchImpl);
		await githubToken(fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("re-exchanges when the cached token is near expiry", async () => {
		useApp();
		const fetchImpl = tokenResponse("ghs_install", 60_000);

		await githubToken(fetchImpl);
		await githubToken(fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("caches separately per permission set", async () => {
		useApp();
		const fetchImpl = tokenResponse("ghs_a", 3_600_000);
		await githubToken(fetchImpl);
		await githubToken({ permissions: { contents: "read" }, fetch: fetchImpl });
		await githubToken(fetchImpl);

		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("narrows permissions when requested", async () => {
		useApp();
		const fetchImpl = tokenResponse("ghs_narrow", 3_600_000);
		await githubToken({ permissions: { contents: "read" }, fetch: fetchImpl });

		const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body.permissions).toEqual({ contents: "read" });
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
