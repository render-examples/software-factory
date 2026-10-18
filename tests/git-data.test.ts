import { afterEach, describe, expect, it } from "vitest";
import type { RepoContext } from "../app/config/index.js";
import { GitDataError, gitData, headsPath } from "../app/github/git-data.js";

const REPO: RepoContext = {
	owner: "acme",
	name: "widgets",
	fullName: "acme/widgets",
	installationId: 9,
	config: { baseBranch: "main", verify: [] },
};
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

interface Call {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

/** A fetch that answers from a queue and records every request. */
function fakeFetch(responses: Array<Response | Error>) {
	const calls: Call[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			method: init?.method ?? "GET",
			url: String(input),
			headers: init?.headers as Record<string, string>,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		const next = responses.shift();
		if (!next) throw new Error("no more responses");
		if (next instanceof Error) throw next;
		return next;
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

function client(responses: Array<Response | Error>) {
	const f = fakeFetch(responses);
	const sleeps: number[] = [];
	const git = gitData(REPO, {
		fetch: f.fetch,
		token: async () => "ghs_write",
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	return { git, calls: f.calls, sleeps };
}

afterEach(() => {
	delete process.env.GITHUB_API_URL;
});

describe("gitData", () => {
	it("encodes each branch segment but keeps slashes", () => {
		expect(headsPath("factory/issue 7#x")).toBe("heads/factory/issue%207%23x");
	});

	it("reads a commit's tree with the write token", async () => {
		process.env.GITHUB_API_URL = "https://ghe.example.com/api/v3/";
		const { git, calls } = client([
			json(200, {
				sha: SHA_A,
				tree: { sha: SHA_B },
				parents: [{ sha: SHA_B }],
			}),
		]);
		expect(await git.getCommit(SHA_A)).toEqual({
			sha: SHA_A,
			treeSha: SHA_B,
			parents: [SHA_B],
		});
		expect(calls[0]?.url).toBe(`https://ghe.example.com/api/v3/repos/acme/widgets/git/commits/${SHA_A}`);
		expect(calls[0]?.headers.Authorization).toBe("Bearer ghs_write");
	});

	it("rejects a commit response for a different SHA", async () => {
		const { git } = client([json(200, { sha: SHA_B, tree: { sha: SHA_B }, parents: [] })]);
		await expect(git.getCommit(SHA_A)).rejects.toThrow(/returned commit/);
	});

	it("sends blobs as base64", async () => {
		const { git, calls } = client([json(201, { sha: SHA_A })]);
		expect(await git.createBlob(Buffer.from([0, 255, 10]))).toBe(SHA_A);
		expect(calls[0]?.body).toEqual({ content: "AP8K", encoding: "base64" });
	});

	it("sends tree entries, including deletions, as given", async () => {
		const { git, calls } = client([json(201, { sha: SHA_B })]);
		const entries = [
			{
				path: "old",
				mode: "100644" as const,
				type: "blob" as const,
				sha: null,
			},
			{
				path: "old/new",
				mode: "100755" as const,
				type: "blob" as const,
				sha: SHA_A,
			},
		];
		expect(await git.createTree(SHA_A, entries)).toBe(SHA_B);
		expect(calls[0]?.body).toEqual({ base_tree: SHA_A, tree: entries });
	});

	it("returns null for a missing branch and the target for an existing one", async () => {
		const { git, calls } = client([
			json(404, { message: "Not Found" }),
			json(200, {
				ref: "refs/heads/feat/x",
				object: { sha: SHA_A, type: "commit" },
			}),
		]);
		expect(await git.getRef("feat/x")).toBeNull();
		expect(await git.getRef("feat/x")).toBe(SHA_A);
		expect(calls[0]?.url).toMatch(/\/git\/ref\/heads\/feat\/x$/);
	});

	it("rejects a ref response for a different ref", async () => {
		const { git } = client([
			json(200, {
				ref: "refs/heads/feat",
				object: { sha: SHA_A, type: "commit" },
			}),
		]);
		await expect(git.getRef("feat/x")).rejects.toThrow(/returned refs\/heads\/feat/);
	});

	it("creates and updates refs", async () => {
		const { git, calls } = client([json(201, {}), json(200, {})]);
		await git.createRef("feat/x", SHA_A);
		await git.updateRef("feat/x", SHA_B);
		expect(calls[0]).toMatchObject({
			method: "POST",
			body: { ref: "refs/heads/feat/x", sha: SHA_A },
		});
		expect(calls[1]).toMatchObject({
			method: "PATCH",
			body: { sha: SHA_B, force: false },
		});
		expect(calls[1]?.url).toMatch(/\/git\/refs\/heads\/feat\/x$/);
	});

	it("surfaces 422 as a GitDataError without retrying", async () => {
		const { git, calls } = client([json(422, { message: "Reference already exists" })]);
		const err = await git.createRef("x", SHA_A).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GitDataError);
		expect((err as GitDataError).status).toBe(422);
		expect(calls).toHaveLength(1);
	});

	it("retries server errors and network failures with backoff", async () => {
		const { git, sleeps } = client([new TypeError("fetch failed"), json(502, {}), json(201, { sha: SHA_A })]);
		expect(await git.createBlob(Buffer.from("x"))).toBe(SHA_A);
		expect(sleeps).toEqual([1000, 2000]);
	});

	it("honors retry-after and caps it at a minute", async () => {
		const { git, sleeps } = client([
			json(429, {}, { "retry-after": "3" }),
			json(403, { message: "secondary rate limit" }, { "retry-after": "600" }),
			json(201, { sha: SHA_A }),
		]);
		expect(await git.createBlob(Buffer.from("x"))).toBe(SHA_A);
		expect(sleeps).toEqual([3000, 60_000]);
	});

	it("does not retry a plain 403", async () => {
		const { git, calls } = client([json(403, { message: "Resource not accessible by integration" })]);
		await expect(git.createBlob(Buffer.from("x"))).rejects.toThrow(/403/);
		expect(calls).toHaveLength(1);
	});

	it("gives up after five attempts", async () => {
		const { git, calls } = client([json(500, {}), json(500, {}), json(500, {}), json(500, {}), json(500, {})]);
		await expect(git.createBlob(Buffer.from("x"))).rejects.toBeInstanceOf(GitDataError);
		expect(calls).toHaveLength(5);
	});

	it("rejects malformed SHAs in responses", async () => {
		const { git } = client([json(201, { sha: "nope" })]);
		await expect(git.createBlob(Buffer.from("x"))).rejects.toThrow(/Invalid blob SHA/);
	});
});
