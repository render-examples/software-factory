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

function fakeFetch() {
	const requests: Request[] = [];
	let n = 0;
	const fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
		requests.push({
			url: String(input),
			headers: init?.headers as Record<string, string>,
			body: JSON.parse(String(init?.body)),
		});
		const expires = new Date(Date.now() + 60 * 60_000).toISOString();
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
		expect(await githubToken({ installationId: 99, repo: "web", permissions: { contents: "read" }, fetch })).toBe(token);
		expect(requests).toHaveLength(1);
	});
});
