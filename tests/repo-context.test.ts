/**
 * Triage gates the run before a sandbox exists. This is the context that stops
 * it from asking the maintainer questions the repository already answers.
 */
import { describe, expect, it, vi } from "vitest";
import { repoBrief } from "../app/format/index.js";
import { GitHub, type RepoSnapshot } from "../app/github/index.js";

const repo = { owner: "acme", repo: "widgets" };

function snapshot(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
	return {
		defaultBranch: "main",
		paths: ["src/app.js", "src/todo.js"],
		truncated: false,
		files: [{ path: "package.json", content: '{"name":"todo"}' }],
		...overrides,
	};
}

/** Serves canned JSON per path; anything unlisted is a 404. */
function stubFetch(routes: Record<string, unknown>) {
	return vi.fn(async (input: string | URL | Request) => {
		const url = String(input).replace("https://api.github.com", "");
		const body = routes[url];
		return body === undefined
			? new Response('{"message":"Not Found"}', { status: 404 })
			: new Response(JSON.stringify(body), { status: 200 });
	}) as unknown as typeof fetch;
}

describe("repoBrief", () => {
	it("names the repository, its branch, and its files", () => {
		const brief = repoBrief("acme/widgets", snapshot());

		expect(brief).toContain("# Repository: acme/widgets");
		expect(brief).toContain("Default branch: main");
		expect(brief).toContain("src/todo.js");
		expect(brief).toContain("## Files (2)");
	});

	it("includes the content of the self-describing files", () => {
		expect(repoBrief("acme/widgets", snapshot())).toContain('{"name":"todo"}');
	});

	it("says so when the file list was cut short", () => {
		expect(repoBrief("acme/widgets", snapshot({ truncated: true }))).toContain(
			"truncated",
		);
	});
});

describe("getRepoSnapshot", () => {
	const tree = {
		truncated: false,
		tree: [
			{ path: "src", type: "tree" },
			{ path: "src/todo.js", type: "blob" },
			{ path: "README.md", type: "blob" },
			{ path: ".github/workflows/ci.yml", type: "blob" },
			{ path: "node_modules/left-pad/index.js", type: "blob" },
			{ path: "dist/bundle.js", type: "blob" },
		],
	};

	function client(routes: Record<string, unknown>) {
		return new GitHub(() => "token", stubFetch(routes));
	}

	it("reads the tree from the default branch and decodes context files", async () => {
		const result = await client({
			"/repos/acme/widgets": { default_branch: "trunk" },
			"/repos/acme/widgets/git/trees/trunk?recursive=1": tree,
			"/repos/acme/widgets/contents/README.md": {
				encoding: "base64",
				content: Buffer.from("# Todo app").toString("base64"),
			},
		}).getRepoSnapshot(repo);

		expect(result.defaultBranch).toBe("trunk");
		expect(result.paths).toEqual(["README.md", "src/todo.js"]);
		expect(result.files).toEqual([
			{ path: "README.md", content: "# Todo app" },
		]);
	});

	// Build output and dependencies describe nothing about the project.
	it("drops generated, vendored, and dotted paths", async () => {
		const result = await client({
			"/repos/acme/widgets": { default_branch: "main" },
			"/repos/acme/widgets/git/trees/main?recursive=1": tree,
		}).getRepoSnapshot(repo);

		expect(result.paths).not.toContain("node_modules/left-pad/index.js");
		expect(result.paths).not.toContain("dist/bundle.js");
		expect(result.paths).not.toContain(".github/workflows/ci.yml");
	});

	it("treats a missing context file as absent rather than an error", async () => {
		const result = await client({
			"/repos/acme/widgets": { default_branch: "main" },
			"/repos/acme/widgets/git/trees/main?recursive=1": tree,
		}).getRepoSnapshot(repo);

		expect(result.files).toEqual([]);
	});
});
