import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubToken, resetTokenCache } from "../app/github/auth.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

interface Request {
	url: string;
	headers: Record<string, string>;
	body: { repositories: string[]; permissions?: Record<string, string> };
}

function fakeFetch(opts: { status?: number; expiresInMs?: number } = {}) {
	const requests: Request[] = [];
	let n = 0;
	const fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
		requests.push({
			url: String(input),
			headers: init?.headers as Record<string, string>,
			body: JSON.parse(String(init?.body)),
		});
		if (opts.status && opts.status !== 201) return new Response("Bad credentials", { status: opts.status });
		const expires = new Date(Date.now() + (opts.expiresInMs ?? 60 * 60_000)).toISOString();
		return new Response(JSON.stringify({ token: `ghs_token_${++n}`, expires_at: expires }), { status: 201 });
	}) as typeof globalThis.fetch;
	return { fetch, requests };
}

function decodeJwt(jwt: string) {
	const [header, payload, signature] = jwt.split(".");
	const verifier = createVerify("RSA-SHA256");
	verifier.update(`${header}.${payload}`);
	return {
		header: JSON.parse(Buffer.from(header ?? "", "base64url").toString()),
		payload: JSON.parse(Buffer.from(payload ?? "", "base64url").toString()),
		valid: verifier.verify(publicKey, signature ?? "", "base64url"),
	};
}

beforeEach(() => {
	resetTokenCache();
	vi.stubEnv("GITHUB_APP_ID", "12345");
	vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
	vi.stubEnv("GITHUB_API_URL", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("githubToken", () => {
	it("mints a token restricted to one repository with an RS256 App JWT", async () => {
		const { fetch, requests } = fakeFetch();
		const token = await githubToken({ installationId: 99, repo: "web", permissions: { contents: "read" }, fetch });
		expect(token).toBe("ghs_token_1");
		expect(requests).toHaveLength(1);
		const [req] = requests;
		expect(req?.url).toBe("https://api.github.com/app/installations/99/access_tokens");
		expect(req?.body).toEqual({ repositories: ["web"], permissions: { contents: "read" } });
		const jwt = decodeJwt((req?.headers.Authorization ?? "").replace(/^Bearer /, ""));
		expect(jwt.valid).toBe(true);
		expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT" });
		const now = Math.floor(Date.now() / 1000);
		expect(jwt.payload.iss).toBe("12345");
		expect(jwt.payload.iat).toBeLessThanOrEqual(now - 59);
		expect(jwt.payload.exp - jwt.payload.iat).toBeLessThanOrEqual(600);
	});

	it("caches per installation, repository, and permission set", async () => {
		const { fetch, requests } = fakeFetch();
		const a = await githubToken({ installationId: 1, repo: "web", permissions: { contents: "read", metadata: "read" }, fetch });
		const b = await githubToken({ installationId: 1, repo: "web", permissions: { metadata: "read", contents: "read" }, fetch });
		expect(b).toBe(a);
		expect(requests).toHaveLength(1);
		await githubToken({ installationId: 1, repo: "api", permissions: { contents: "read", metadata: "read" }, fetch });
		await githubToken({ installationId: 2, repo: "web", permissions: { contents: "read", metadata: "read" }, fetch });
		await githubToken({ installationId: 1, repo: "web", permissions: { contents: "write" }, fetch });
		await githubToken({ installationId: 1, repo: "web", fetch });
		expect(requests).toHaveLength(5);
	});

	it("renews a token within five minutes of expiry", async () => {
		const { fetch, requests } = fakeFetch({ expiresInMs: 10 * 60_000 });
		vi.useFakeTimers({ toFake: ["Date"] });
		await githubToken({ installationId: 1, repo: "web", fetch });
		vi.setSystemTime(Date.now() + 4 * 60_000);
		await githubToken({ installationId: 1, repo: "web", fetch });
		expect(requests).toHaveLength(1);
		vi.setSystemTime(Date.now() + 2 * 60_000);
		expect(await githubToken({ installationId: 1, repo: "web", fetch })).toBe("ghs_token_2");
		expect(requests).toHaveLength(2);
	});
});
