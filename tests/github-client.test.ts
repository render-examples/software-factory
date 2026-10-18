import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubError, GitHubHttp, githubFor, resetBotLoginCache, retryDelay } from "../app/github/index.js";

const API = "https://api.github.test";

interface Call {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

type Route = (call: Call) => Response | Promise<Response>;

function fakeFetch(...responses: (Response | Route | Error)[]) {
	const calls: Call[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const call: Call = {
			method: init?.method ?? "GET",
			url: String(input),
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		};
		calls.push(call);
		const next = responses.length > 1 ? responses.shift() : responses[0];
		if (!next) throw new Error(`unexpected request ${call.method} ${call.url}`);
		if (next instanceof Error) throw next;
		return typeof next === "function" ? next(call) : next.clone();
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...init.headers } });
}

function http(fetch: typeof globalThis.fetch, sleeps: number[] = []) {
	return new GitHubHttp(() => "ghs_secret_token", {
		fetch,
		apiUrl: API,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
}

function client(fetch: typeof globalThis.fetch) {
	return githubFor({ owner: "acme", name: "web", installationId: 7 }, { fetch, apiUrl: API, token: () => "ghs_t", sleep: async () => {} });
}

describe("GitHubHttp", () => {
	it("sends GitHub headers and the token", async () => {
		const { fetch, calls } = fakeFetch(json({ ok: true }));
		await http(fetch).json("GET", "/repos/acme/web");
		expect(calls[0]?.url).toBe(`${API}/repos/acme/web`);
		expect(calls[0]?.headers).toMatchObject({
			Authorization: "Bearer ghs_secret_token",
			Accept: "application/vnd.github+json",
			"User-Agent": "software-factory",
			"X-GitHub-Api-Version": "2022-11-28",
		});
	});

	it("retries a GET on 5xx and 429 with backoff", async () => {
		const sleeps: number[] = [];
		const { fetch, calls } = fakeFetch(new Response("", { status: 502 }), new Response("", { status: 429 }), json({ n: 1 }));
		expect(await http(fetch, sleeps).json("GET", "/x")).toEqual({ n: 1 });
		expect(calls).toHaveLength(3);
		expect(sleeps).toHaveLength(2);
		expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0);
	});

	it("honors retry-after on a secondary rate limit 403", async () => {
		const sleeps: number[] = [];
		const { fetch, calls } = fakeFetch(
			new Response("You have exceeded a secondary rate limit", { status: 403, headers: { "retry-after": "7" } }),
			json({}),
		);
		await http(fetch, sleeps).json("GET", "/x");
		expect(calls).toHaveLength(2);
		expect(sleeps).toEqual([7000]);
	});

	it("waits a minute for a secondary rate limit that names no wait", () => {
		const response = new Response("", { status: 403 });
		expect(retryDelay(response, "You have exceeded a secondary rate limit.", 1)).toBe(60_000);
	});

	it("waits until x-ratelimit-reset when the primary limit is exhausted", () => {
		const now = 1_700_000_000_000;
		const response = new Response("", {
			status: 403,
			headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 12) },
		});
		expect(retryDelay(response, "API rate limit exceeded", 1, now)).toBe(12_000);
	});

	it("fails instead of waiting longer than 60 seconds", async () => {
		const { fetch, calls } = fakeFetch(new Response("slow down", { status: 429, headers: { "retry-after": "120" } }));
		await expect(http(fetch).json("GET", "/x")).rejects.toMatchObject({ status: 429 });
		expect(calls).toHaveLength(1);
	});

	it("does not retry a plain 403 or a 404", async () => {
		for (const status of [403, 404]) {
			const { fetch, calls } = fakeFetch(new Response("no", { status }));
			await expect(http(fetch).json("GET", "/x")).rejects.toBeInstanceOf(GitHubError);
			expect(calls).toHaveLength(1);
		}
	});

	it("retries POST only when the caller marks it idempotent", async () => {
		const once = fakeFetch(new Response("", { status: 503 }), json({}));
		await expect(http(once.fetch).json("POST", "/x", { body: {} })).rejects.toMatchObject({ status: 503 });
		expect(once.calls).toHaveLength(1);

		const twice = fakeFetch(new Response("", { status: 503 }), json({ ok: 1 }));
		expect(await http(twice.fetch).json("POST", "/x", { body: {}, idempotent: true })).toEqual({ ok: 1 });
		expect(twice.calls).toHaveLength(2);
	});

	it("retries a GET after a network error", async () => {
		const { fetch, calls } = fakeFetch(new TypeError("fetch failed"), json({ ok: 1 }));
		expect(await http(fetch).json("GET", "/x")).toEqual({ ok: 1 });
		expect(calls).toHaveLength(2);
	});

	it("gives up after maxAttempts", async () => {
		const { fetch, calls } = fakeFetch(new Response("", { status: 500 }));
		await expect(http(fetch).json("GET", "/x")).rejects.toMatchObject({ status: 500 });
		expect(calls).toHaveLength(4);
	});

	it("scrubs the token from error messages", async () => {
		const { fetch } = fakeFetch(new Response("bad token ghs_secret_token", { status: 401 }));
		const error = (await http(fetch).json("GET", "/x").catch((e) => e)) as GitHubError;
		expect(error.status).toBe(401);
		expect(error.message).not.toContain("ghs_secret_token");
		expect(error.body).not.toContain("ghs_secret_token");
	});

	it("follows Link rel=next and refuses links to another host", async () => {
		const page2 = `${API}/items?per_page=100&page=2`;
		const { fetch, calls } = fakeFetch(json([1, 2], { headers: { link: `<${page2}>; rel="next", <${page2}>; rel="last"` } }), json([3]));
		expect(await http(fetch).paginate("/items")).toEqual([1, 2, 3]);
		expect(calls.map((c) => c.url)).toEqual([`${API}/items?per_page=100`, page2]);

		const evil = fakeFetch(json([1], { headers: { link: '<https://evil.test/items?page=2>; rel="next"' } }));
		await expect(http(evil.fetch).paginate("/items")).rejects.toThrow("Refusing");
		expect(evil.calls).toHaveLength(1);
	});
});

describe("GitHubClient", () => {
	it("encodes branch names per segment", async () => {
		const { fetch, calls } = fakeFetch(json({ object: { sha: "a".repeat(40) } }));
		const gh = client(fetch);
		expect(await gh.getBranchSha("release/2.x")).toBe("a".repeat(40));
		await gh.getBranchSha("factory/issue-12#fix");
		expect(calls[0]?.url).toBe(`${API}/repos/acme/web/git/ref/heads/release/2.x`);
		expect(calls[1]?.url).toBe(`${API}/repos/acme/web/git/ref/heads/factory/issue-12%23fix`);
	});

	it("returns null for a missing branch", async () => {
		const { fetch } = fakeFetch(new Response("Not Found", { status: 404 }));
		expect(await client(fetch).getBranchSha("nope")).toBeNull();
	});

	it("reads role_name, so maintain and triage aren't folded into write and read", async () => {
		const { fetch } = fakeFetch(
			json({ permission: "write", role_name: "maintain" }),
			json({ permission: "read", role_name: "triage" }),
			json({ permission: "write", role_name: "release-manager", user: { permissions: { push: true, triage: true, pull: true } } }),
			new Response("", { status: 404 }),
		);
		const gh = client(fetch);
		expect(await gh.getPermission("a")).toBe("maintain");
		expect(await gh.getPermission("b")).toBe("triage");
		expect(await gh.getPermission("c")).toBe("write");
		expect(await gh.getPermission("stranger")).toBe("none");
	});

	it("lists comments across pages with author and app", async () => {
		const raw = (id: number, login: string, type: string, slug?: string) => ({
			id,
			body: `c${id}`,
			user: { login, type },
			performed_via_github_app: slug ? { slug } : null,
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
			html_url: `https://github.test/c${id}`,
		});
		const { fetch } = fakeFetch(
			json([raw(1, "alice", "User")], { headers: { link: `<${API}/repos/acme/web/issues/3/comments?page=2>; rel="next"` } }),
			json([raw(2, "factory[bot]", "Bot", "factory")]),
		);
		const comments = await client(fetch).listIssueComments(3);
		expect(comments.map((c) => c.id)).toEqual([1, 2]);
		expect(comments[1]).toMatchObject({ author: { login: "factory[bot]", type: "Bot" }, performedViaApp: "factory" });
		expect(comments[0]?.performedViaApp).toBeNull();
	});

	it("returns labeled events for one label", async () => {
		const { fetch } = fakeFetch(
			json([
				{ event: "labeled", created_at: "2026-01-01T00:00:00Z", actor: { login: "a", type: "User" }, label: { name: "factory:triage" } },
				{ event: "labeled", created_at: "2026-01-02T00:00:00Z", actor: { login: "b", type: "User" }, label: { name: "factory:spec-approved" } },
				{ event: "unlabeled", created_at: "2026-01-03T00:00:00Z", actor: null, label: { name: "factory:spec-approved" } },
			]),
		);
		expect(await client(fetch).getLabelEvents(3, "factory:spec-approved")).toEqual([
			{ label: "factory:spec-approved", createdAt: "2026-01-02T00:00:00Z", actor: { login: "b", type: "User" } },
		]);
	});

	it("tolerates removing a label that isn't there", async () => {
		const { fetch, calls } = fakeFetch(new Response("", { status: 404 }));
		await client(fetch).removeLabel(3, "factory:working");
		expect(calls[0]).toMatchObject({ method: "DELETE", url: `${API}/repos/acme/web/issues/3/labels/factory%3Aworking` });
	});

	const rawPull = {
		number: 9,
		state: "open",
		draft: true,
		title: "t",
		body: null,
		head: { sha: "b".repeat(40), ref: "factory/issue-3", repo: { full_name: "acme/web" } },
		base: { sha: "c".repeat(40), ref: "main" },
		html_url: "https://github.test/pull/9",
	};

	it("findOrCreatePull returns the open PR for the head", async () => {
		const { fetch, calls } = fakeFetch(json([rawPull]));
		const { pull, created } = await client(fetch).findOrCreatePull({ head: "factory/issue-3", base: "main", title: "t", body: "b" });
		expect(created).toBe(false);
		expect(pull).toMatchObject({ number: 9, headRef: "factory/issue-3", baseRef: "main", draft: true, body: "" });
		expect(new URL(calls[0]?.url ?? "").searchParams.get("head")).toBe("acme:factory/issue-3");
		expect(calls).toHaveLength(1);
	});

	it("findOrCreatePull opens a draft, and recovers from losing a race", async () => {
		const fresh = fakeFetch(json([]), json(rawPull, { status: 201 }));
		expect((await client(fresh.fetch).findOrCreatePull({ head: "h", base: "main", title: "t", body: "b" })).created).toBe(true);
		expect(fresh.calls[1]).toMatchObject({ method: "POST", body: { head: "h", base: "main", draft: true } });

		const raced = fakeFetch(json([]), new Response("A pull request already exists", { status: 422 }), json([rawPull]));
		expect(await client(raced.fetch).findOrCreatePull({ head: "h", base: "main", title: "t", body: "b" })).toMatchObject({
			created: false,
			pull: { number: 9 },
		});
	});

	it("posts COMMENT reviews and requests diffs with the diff media type", async () => {
		const { fetch, calls } = fakeFetch(
			json({ id: 1, body: "b", user: { login: "x[bot]", type: "Bot" }, commit_id: "d", state: "COMMENTED", html_url: "u" }),
			new Response("diff --git a/x b/x\n"),
		);
		const gh = client(fetch);
		await gh.createReview(9, { commitId: "d", body: "b", event: "COMMENT", comments: [{ path: "x", line: 2, side: "RIGHT", body: "n" }] });
		expect(calls[0]?.body).toEqual({ commit_id: "d", body: "b", event: "COMMENT", comments: [{ path: "x", line: 2, side: "RIGHT", body: "n" }] });
		expect(await gh.getPullDiff(9)).toContain("diff --git");
		expect(calls[1]?.headers.Accept).toBe("application/vnd.github.diff");
	});
});

describe("botLogin", () => {
	const { privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});

	beforeEach(() => {
		resetBotLoginCache();
		vi.stubEnv("GITHUB_APP_ID", "123");
		vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
	});
	afterEach(() => vi.unstubAllEnvs());

	it("resolves <slug>[bot] from GET /app with the App JWT, once per process", async () => {
		const { fetch, calls } = fakeFetch(json({ slug: "software-factory" }));
		expect(await client(fetch).botLogin()).toBe("software-factory[bot]");
		expect(await client(fetch).botLogin()).toBe("software-factory[bot]");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${API}/app`);
		expect(calls[0]?.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
	});

	it("retries resolution after a failure", async () => {
		const failing = fakeFetch(new Response("", { status: 401 }));
		await expect(client(failing.fetch).botLogin()).rejects.toMatchObject({ status: 401 });
		const ok = fakeFetch(json({ slug: "f" }));
		expect(await client(ok.fetch).botLogin()).toBe("f[bot]");
	});
});
