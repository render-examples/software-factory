import { describe, expect, it, vi } from "vitest";
import { GitHub } from "../lib/github.js";

describe("GitHub draft PR ceiling", () => {
	it("always creates the workflow pull request as a draft", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					number: 7,
					title: "Fix #42",
					body: "body",
					html_url: "https://github.com/acme/factory/pull/7",
					head: { ref: "factory/issue-42" },
					base: { ref: "main" },
					state: "open",
					user: { login: "factory" },
				}),
				{ status: 201 },
			),
		);
		const client = new GitHub(
			"token",
			fetchMock as unknown as typeof fetch,
			"https://api.github.test",
		);

		await client.createPull(
			{ owner: "acme", repo: "factory" },
			{
				title: "Fix #42",
				head: "factory/issue-42",
				base: "main",
				body: "body",
				draft: true,
			},
		);

		const request = fetchMock.mock.calls[0][1] as RequestInit;
		expect(JSON.parse(request.body as string)).toMatchObject({ draft: true });
		expect(request.signal).toBeInstanceOf(AbortSignal);
	});

	it("paginates issue comments", async () => {
		const comment = (id: number) => ({
			id,
			body: `comment ${id}`,
			user: { login: "user" },
			created_at: "2026-08-31T00:00:00Z",
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify(
						Array.from({ length: 100 }, (_, index) => comment(index)),
					),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify([comment(100)]), { status: 200 }),
			);
		const client = new GitHub(
			"token",
			fetchMock as unknown as typeof fetch,
			"https://api.github.test",
		);

		const comments = await client.listIssueComments(
			{ owner: "acme", repo: "factory" },
			42,
		);

		expect(comments).toHaveLength(101);
		expect(fetchMock.mock.calls[0][0]).toContain("page=1");
		expect(fetchMock.mock.calls[1][0]).toContain("page=2");
	});

	it("does not duplicate an idempotent issue comment", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify([
					{
						id: 1,
						body: "already sent\n\n<!-- render-factory:attempt-status -->",
						user: { login: "factory" },
						created_at: "2026-08-31T00:00:00Z",
					},
				]),
				{ status: 200 },
			),
		);
		const client = new GitHub(
			"token",
			fetchMock as unknown as typeof fetch,
			"https://api.github.test",
		);

		await client.ensureIssueComment(
			{ owner: "acme", repo: "factory" },
			42,
			"attempt-status",
			"already sent",
		);

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
	});

	it("refuses to reuse a PR whose head differs from the reviewed SHA", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify([
					{
						number: 7,
						title: "Old attempt",
						body: "body",
						html_url: "https://github.test/pull/7",
						head: { ref: "factory/issue-42", sha: "other-sha" },
						base: { ref: "main" },
						state: "open",
						user: { login: "factory" },
					},
				]),
				{ status: 200 },
			),
		);
		const client = new GitHub(
			"token",
			fetchMock as unknown as typeof fetch,
			"https://api.github.test",
		);

		await expect(
			client.ensurePull(
				{ owner: "acme", repo: "factory" },
				{
					title: "Fix #42",
					head: "factory/issue-42",
					base: "main",
					body: "body",
					draft: true,
					expectedHeadSha: "reviewed-sha",
				},
			),
		).rejects.toThrow(/reviewed SHA/);
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
