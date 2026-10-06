/**
 * Tests for upsertMarkedComment: finds existing by marker, or creates new.
 */
import { beforeEach, describe, expect, it } from "vitest";

const requests: Array<{
	method: string;
	url: string;
	body?: Record<string, string>;
}> = [];

function makeFetch(
	handlers: Array<{
		match: (method: string, url: string) => boolean;
		response: unknown;
	}>,
): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		requests.push({ method, url, body });

		for (const h of handlers) {
			if (h.match(method, url)) {
				return new Response(JSON.stringify(h.response), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
		}
		return new Response(JSON.stringify([]), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

describe("upsertMarkedComment", () => {
	beforeEach(() => {
		requests.length = 0;
	});

	it("creates a new comment when no marker exists", async () => {
		const { GitHub } = await import("../app/github/client.js");

		const gh = new GitHub(
			async () => "fake-token",
			makeFetch([
				{
					match: (m, u) => m === "GET" && u.includes("/issues/1/comments"),
					response: [],
				},
				{
					match: (m, u) => m === "POST" && u.includes("/issues/1/comments"),
					response: { id: 42 },
				},
			]),
			"https://api.test.com",
		);

		const result = await gh.upsertMarkedComment(
			{ owner: "o", repo: "r" },
			1,
			"<!-- marker:test -->",
			"Hello world",
		);

		expect(result.id).toBe("42");
		const postReq = requests.find((r) => r.method === "POST");
		expect(postReq).toBeDefined();
		expect(postReq?.body?.body).toContain("Hello world");
		expect(postReq?.body?.body).toContain("<!-- marker:test -->");
	});

	it("updates existing comment when marker is found", async () => {
		const { GitHub } = await import("../app/github/client.js");

		const gh = new GitHub(
			async () => "fake-token",
			makeFetch([
				{
					match: (m, u) => m === "GET" && u.includes("/issues/2/comments"),
					response: [
						{
							id: 99,
							body: "old body\n\n<!-- marker:test -->",
							user: { login: "bot", type: "Bot" },
							created_at: "2026-01-01T00:00:00Z",
						},
					],
				},
				{
					match: (m, u) => m === "PATCH" && u.includes("/issues/comments/99"),
					response: { id: 99 },
				},
			]),
			"https://api.test.com",
		);

		const result = await gh.upsertMarkedComment(
			{ owner: "o", repo: "r" },
			2,
			"<!-- marker:test -->",
			"Updated body",
		);

		expect(result.id).toBe("99");
		const patchReq = requests.find((r) => r.method === "PATCH");
		expect(patchReq).toBeDefined();
		expect(patchReq?.body?.body).toContain("Updated body");
		expect(patchReq?.body?.body).toContain("<!-- marker:test -->");
		// No POST should have been made
		expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
	});
});
