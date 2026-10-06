import { describe, expect, it } from "vitest";
import { ensureReview, getPull, getPullDiff } from "../app/github/pulls.js";
import { GitHubHttp } from "../app/github/request.js";

function fakeHttp(responses: Record<string, unknown>): GitHubHttp {
	const fetchImpl = async (url: string, init?: RequestInit) => {
		const parsed = new URL(url);
		const pathWithQuery = parsed.pathname + parsed.search;
		const key = `${init?.method ?? "GET"} ${pathWithQuery}`;
		const body = responses[key];
		if (body === undefined) {
			return new Response("Not found", { status: 404 });
		}
		const isString = typeof body === "string";
		return new Response(isString ? body : JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": isString ? "text/plain" : "application/json" },
		});
	};
	return new GitHubHttp(() => "fake-token", fetchImpl as typeof fetch);
}

const ref = { owner: "test-org", repo: "test-repo" };

describe("getPull", () => {
	it("returns structured pull data", async () => {
		const http = fakeHttp({
			"GET /repos/test-org/test-repo/pulls/42": {
				number: 42,
				state: "open",
				head: { sha: "abc123" },
				base: { sha: "def456" },
				body: "PR body text",
				title: "Fix stuff",
				html_url: "https://github.com/test-org/test-repo/pull/42",
			},
		});
		const pull = await getPull(http, ref, 42);
		expect(pull.number).toBe(42);
		expect(pull.state).toBe("open");
		expect(pull.headSha).toBe("abc123");
		expect(pull.baseSha).toBe("def456");
	});
});

describe("getPullDiff", () => {
	it("returns raw diff text", async () => {
		const diffText = "diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts";
		const http = fakeHttp({
			"GET /repos/test-org/test-repo/pulls/42": diffText,
		});
		const diff = await getPullDiff(http, ref, 42);
		expect(diff).toBe(diffText);
	});
});

describe("ensureReview", () => {
	it("finds existing review by marker", async () => {
		const marker = "<!-- render-factory:review run=run-123 -->";
		const http = fakeHttp({
			"GET /repos/test-org/test-repo/pulls/42/reviews?per_page=100": [
				{ id: 1, body: `Review body\n\n${marker}`, state: "COMMENTED" },
			],
		});
		const result = await ensureReview(http, ref, 42, {
			commitId: "abc123",
			body: "New review",
			comments: [],
			marker,
		});
		expect(result.id).toBe(1);
		expect(result.alreadyExisted).toBe(true);
	});

	it("submits a new COMMENT review when no match", async () => {
		const marker = "<!-- render-factory:review run=run-456 -->";
		const http = fakeHttp({
			"GET /repos/test-org/test-repo/pulls/42/reviews?per_page=100": [],
			"POST /repos/test-org/test-repo/pulls/42/reviews": {
				id: 99,
				body: "New body",
				state: "COMMENTED",
			},
		});
		const result = await ensureReview(http, ref, 42, {
			commitId: "abc123",
			body: "Review content",
			comments: [{ path: "f.ts", line: 10, body: "Fix this" }],
			marker,
		});
		expect(result.id).toBe(99);
		expect(result.alreadyExisted).toBe(false);
	});
});
