import { describe, expect, it } from "vitest";
import { type GitHubError, GitHubHttp, githubFor } from "../app/github/index.js";

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

	it("scrubs the token from error messages", async () => {
		const { fetch } = fakeFetch(new Response("bad token ghs_secret_token", { status: 401 }));
		const error = (await http(fetch)
			.json("GET", "/x")
			.catch((e) => e)) as GitHubError;
		expect(error.status).toBe(401);
		expect(error.message).not.toContain("ghs_secret_token");
		expect(error.body).not.toContain("ghs_secret_token");
	});
});

describe("GitHubClient", () => {
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
});
