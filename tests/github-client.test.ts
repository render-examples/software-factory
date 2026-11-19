import { describe, expect, it } from "vitest";
import { type GitHubError, GitHubHttp, githubFor } from "../app/github/index.js";
import { fakeFetch, json } from "./helpers/fake-fetch.js";

const API = "https://api.github.test";

function http(fetch: typeof globalThis.fetch) {
	return new GitHubHttp(() => "ghs_secret_token", { fetch, apiUrl: API, sleep: async () => {} });
}

function client(fetch: typeof globalThis.fetch) {
	return githubFor({ owner: "acme", name: "web", installationId: 7 }, { fetch, apiUrl: API, token: () => "ghs_t", sleep: async () => {} });
}

describe("GitHubHttp", () => {
	it("scrubs the token from error messages", async () => {
		const { fetch } = fakeFetch({ "GET /x": new Response("bad token ghs_secret_token", { status: 401 }) });
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

	it("ensurePull opens a draft, and recovers from losing a race", async () => {
		const fresh = fakeFetch({ "GET /repos/acme/web/pulls": [], "POST /repos/acme/web/pulls": json(rawPull, 201) });
		expect((await client(fresh.fetch).ensurePull({ head: "h", base: "main", title: "t", body: "b" })).created).toBe(true);
		expect(fresh.requests.find((r) => r.method === "POST")).toMatchObject({ body: { head: "h", base: "main", draft: true } });

		const open: (typeof rawPull)[] = [];
		const raced = fakeFetch({
			"GET /repos/acme/web/pulls": () => open,
			"POST /repos/acme/web/pulls": () => {
				open.push(rawPull);
				return new Response("A pull request already exists", { status: 422 });
			},
		});
		expect(await client(raced.fetch).ensurePull({ head: "h", base: "main", title: "t", body: "b" })).toMatchObject({
			created: false,
			pull: { number: 9 },
		});
	});
});
