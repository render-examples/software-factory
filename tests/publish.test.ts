import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepoContext } from "../app/config/index.js";
import { type GitDataClient, gitData } from "../app/github/git-data.js";
import { blobSha, type PublishInput, publish, type RefusalReason } from "../app/publish/index.js";
import type { ExecOptions, ExecResult, Sandbox } from "../app/sandbox/types.js";

const SCRIPT = fileURLToPath(new URL("../sandbox-runtime/collect-changes.sh", import.meta.url));
const IDENTITY = {
	name: "Factory Bot",
	email: "bot@example.com",
	date: "2026-10-18T12:00:00Z",
};
const REPO: RepoContext = {
	owner: "acme",
	name: "widgets",
	fullName: "acme/widgets",
	installationId: 1,
	config: { baseBranch: "main", verify: [] },
};
const LIMITS = { maxChangedFiles: 50, maxFileBytes: 100_000 };
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

let tmp: string;
let counter = 0;

beforeAll(async () => {
	tmp = await mkdtemp(join(tmpdir(), "publish-test-"));
});
afterAll(async () => {
	await rm(tmp, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
	return gitRaw(dir, ...args)
		.toString("utf8")
		.trim();
}
function gitRaw(dir: string, ...args: string[]): Buffer {
	return execFileSync("git", args, {
		cwd: dir,
		env: GIT_ENV,
		maxBuffer: 1 << 26,
		stdio: ["ignore", "pipe", "pipe"],
	});
}
const sha1 = (data: Buffer): string => createHash("sha1").update(data).digest("hex");
const write = (dir: string, path: string, data: string | Buffer): void => {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), data);
};

/** A repository with one base commit whose attributes would change bytes under `git archive`. */
function makeRepo(): { dir: string; base: string } {
	const dir = join(tmp, `repo-${++counter}`);
	mkdirSync(dir);
	git(dir, "init", "-q", "-b", "main");
	write(dir, ".gitattributes", "*.txt text eol=crlf\n*.bin binary\n/ignored/** export-ignore\n*.id ident\n");
	write(dir, "a.txt", "hello\n");
	write(dir, "ignored/keep.txt", "keep\n");
	write(dir, "app/s/page.tsx", "s\n");
	write(dir, "conv", "file\n");
	write(dir, "dir2/x.txt", "x\n");
	write(dir, "run.sh", "#!/bin/sh\n");
	write(dir, "gone.txt", "bye\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "base");
	return { dir, base: git(dir, "rev-parse", "HEAD") };
}

// ---------------------------------------------------------------------------------------------------------------
// Fake GitHub: an in-memory Git Data API that hashes trees the way git does.

interface Entry {
	mode: string;
	sha: string;
}

function hashTree(flat: Map<string, Entry>): string {
	type Node = Map<string, Entry | Node>;
	const root: Node = new Map();
	for (const [path, entry] of flat) {
		const parts = path.split("/");
		let node = root;
		for (const dir of parts.slice(0, -1)) {
			let child = node.get(dir);
			if (!(child instanceof Map)) {
				child = new Map();
				node.set(dir, child);
			}
			node = child;
		}
		node.set(parts.at(-1) as string, entry);
	}
	const hash = (node: Node): string => {
		const items = [...node].map(([name, value]) =>
			value instanceof Map ? { name, key: `${name}/`, mode: "40000", sha: hash(value) } : { name, key: name, ...value },
		);
		items.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
		const body = Buffer.concat(items.flatMap((i) => [Buffer.from(`${i.mode} ${i.name}\0`), Buffer.from(i.sha, "hex")]));
		return sha1(Buffer.concat([Buffer.from(`tree ${body.length}\0`), body]));
	};
	return hash(root);
}

type Interceptor = (method: string, path: string, body: unknown) => Response | undefined;

interface RequestBody {
	content?: string;
	base_tree?: string;
	tree?: unknown;
	parents?: string[];
	author?: { date?: string };
	ref?: string;
	sha?: string;
	force?: boolean;
}

class FakeGitHub {
	readonly blobs = new Map<string, Buffer>();
	readonly trees = new Map<string, Map<string, Entry>>();
	readonly commits = new Map<string, { tree: string; parents: string[]; body: unknown }>();
	readonly refs = new Map<string, string>();
	readonly calls: Array<{ method: string; path: string; body: unknown }> = [];
	readonly interceptors: Interceptor[] = [];
	readonly sleeps: number[] = [];

	/** Seeds the base commit from the real repository, before any sandbox tampering. */
	static fromRepo(dir: string, base: string): FakeGitHub {
		const gh = new FakeGitHub();
		const flat = new Map<string, Entry>();
		const out = gitRaw(dir, "ls-tree", "-r", "-z", "--full-tree", base).toString("utf8");
		for (const record of out.split("\0").filter(Boolean)) {
			const [meta, path] = record.split("\t") as [string, string];
			const [mode, , sha] = meta.split(" ") as [string, string, string];
			flat.set(path, { mode, sha });
		}
		const tree = hashTree(flat);
		expect(tree).toBe(git(dir, "rev-parse", `${base}^{tree}`));
		gh.trees.set(tree, flat);
		gh.commits.set(base, { tree, parents: [], body: null });
		return gh;
	}

	client(): GitDataClient {
		return gitData(REPO, {
			fetch: this.fetch,
			token: async () => "ghs_test",
			sleep: async (ms) => {
				this.sleeps.push(ms);
			},
		});
	}

	private json(status: number, body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}

	readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const body: RequestBody = init?.body ? JSON.parse(String(init.body)) : {};
		const prefix = "/repos/acme/widgets/git";
		if (!url.pathname.startsWith(prefix)) return this.json(404, { message: "Not Found" });
		const path = url.pathname.slice(prefix.length);
		this.calls.push({ method, path, body });
		for (const intercept of this.interceptors) {
			const response = intercept(method, path, body);
			if (response) return response;
		}
		return this.route(method, path, body);
	}) as typeof fetch;

	private route(method: string, path: string, body: RequestBody): Response {
		const commitMatch = /^\/commits\/([0-9a-f]{40})$/.exec(path);
		const refMatch = /^\/refs?\/heads\/(.+)$/.exec(path);
		const branch = refMatch ? (refMatch[1] as string).split("/").map(decodeURIComponent).join("/") : "";
		if (method === "GET" && commitMatch) {
			const commit = this.commits.get(commitMatch[1] as string);
			if (!commit) return this.json(404, { message: "Not Found" });
			return this.json(200, {
				sha: commitMatch[1],
				tree: { sha: commit.tree },
				parents: commit.parents.map((sha) => ({ sha })),
			});
		}
		if (method === "POST" && path === "/blobs") {
			const content = Buffer.from(String(body.content), "base64");
			const sha = blobSha(content);
			this.blobs.set(sha, content);
			return this.json(201, { sha });
		}
		if (method === "POST" && path === "/trees") {
			const base = this.trees.get(String(body.base_tree));
			if (!base) return this.json(422, { message: "base_tree is not a tree" });
			const tree = new Map(base);
			for (const e of body.tree as Array<{
				path: string;
				mode: string;
				sha: string | null;
			}>) {
				if (e.sha === null) {
					tree.delete(e.path);
					continue;
				}
				if (!this.blobs.has(e.sha)) return this.json(422, { message: `blob ${e.sha} not found` });
				const parts = e.path.split("/");
				for (let i = 1; i < parts.length; i++) {
					if (tree.has(parts.slice(0, i).join("/"))) return this.json(422, { message: `${e.path} is under a file` });
				}
				if ([...tree.keys()].some((k) => k.startsWith(`${e.path}/`))) {
					return this.json(422, { message: `${e.path} is a directory` });
				}
				tree.set(e.path, { mode: e.mode, sha: e.sha });
			}
			const sha = hashTree(tree);
			this.trees.set(sha, tree);
			return this.json(201, { sha });
		}
		if (method === "POST" && path === "/commits") {
			const tree = String(body.tree);
			if (!this.trees.has(tree)) return this.json(422, { message: "tree not found" });
			const sha = sha1(Buffer.from(JSON.stringify(body.author?.date ? body : { ...body, nonce: Math.random() })));
			this.commits.set(sha, { tree, parents: body.parents ?? [], body });
			return this.json(201, { sha });
		}
		if (method === "GET" && refMatch && path.startsWith("/ref/")) {
			const sha = this.refs.get(branch);
			if (!sha) return this.json(404, { message: "Not Found" });
			return this.json(200, {
				ref: `refs/heads/${branch}`,
				object: { sha, type: "commit" },
			});
		}
		if (method === "POST" && path === "/refs") {
			const name = String(body.ref).replace(/^refs\/heads\//, "");
			const sha = String(body.sha);
			if (this.refs.has(name)) return this.json(422, { message: "Reference already exists" });
			if (!this.commits.has(sha)) return this.json(422, { message: "Object does not exist" });
			this.refs.set(name, sha);
			return this.json(201, { ref: body.ref, object: { sha } });
		}
		if (method === "PATCH" && refMatch && path.startsWith("/refs/")) {
			const current = this.refs.get(branch);
			const sha = String(body.sha);
			if (!current) return this.json(422, { message: "Reference does not exist" });
			if (!body.force && !this.isAncestor(current, sha)) return this.json(422, { message: "Update is not a fast forward" });
			this.refs.set(branch, sha);
			return this.json(200, { ref: `refs/heads/${branch}`, object: { sha } });
		}
		return this.json(404, { message: `No route for ${method} ${path}` });
	}

	private isAncestor(ancestor: string, sha: string): boolean {
		const queue = [sha];
		while (queue.length) {
			const next = queue.pop() as string;
			if (next === ancestor) return true;
			queue.push(...(this.commits.get(next)?.parents ?? []));
		}
		return false;
	}

	/** Paths and contents of a stored tree, for comparing with git. */
	files(tree: string): Map<string, Entry> {
		return this.trees.get(tree) ?? new Map();
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Fake sandbox: exec runs the command locally; download reads the local file.

class LocalSandbox implements Sandbox {
	readonly id = "sbx-local";
	readonly execs: Array<{ command: string; opts?: ExecOptions }> = [];
	readonly downloads: string[] = [];
	tamper: ((file: Buffer) => Buffer) | undefined;

	exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
		this.execs.push({ command, opts });
		return new Promise((resolve) => {
			execFile("bash", ["-c", command], { encoding: "utf8", maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
				const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
				resolve({ exitCode: code, stdout, stderr });
			});
		});
	}
	async upload(): Promise<void> {}
	async download(path: string): Promise<Buffer> {
		this.downloads.push(path);
		const file = await readFile(path);
		return this.tamper ? this.tamper(file) : file;
	}
	async close(): Promise<void> {}
}

interface Harness {
	gh: FakeGitHub;
	sandbox: LocalSandbox;
	outPath: string;
	run(overrides?: Partial<PublishInput>): ReturnType<typeof publish>;
}

function harness(dir: string, base: string): Harness {
	const gh = FakeGitHub.fromRepo(dir, base);
	const sandbox = new LocalSandbox();
	const h: Harness = {
		gh,
		sandbox,
		outPath: "",
		run(overrides = {}) {
			h.outPath = join(tmp, `out-${++counter}`);
			return publish(
				{
					sandbox,
					repo: REPO,
					baseSha: base,
					branch: "factory/issue-7",
					message: "Implement #7",
					author: IDENTITY,
					gitData: gh.client(),
					limits: LIMITS,
					...overrides,
				},
				{ scriptPath: SCRIPT, repoDir: dir, outPath: h.outPath },
			);
		},
	};
	return h;
}

function refusals(result: Awaited<ReturnType<typeof publish>>): RefusalReason[] {
	if (!("refused" in result)) throw new Error("expected a refusal");
	return result.refused;
}

const BINARY = Buffer.concat([Buffer.from([0, 1, 2, 0xff, 0xfe, 13, 10, 13, 0]), randomBytes(4000)]);

/** The agent's edits: every case the legacy archive transfer got wrong. */
function editWorkingTree(dir: string): void {
	write(dir, "a.txt", "hello\r\nworld\r\n");
	write(dir, "crlf.txt", "one\r\ntwo\r\n");
	write(dir, "ignored/keep.txt", "kept\n");
	write(dir, "app/[slug]/page.tsx", "export default function Page() {}\n");
	unlinkSync(join(dir, "conv"));
	write(dir, "conv/inner.txt", "now a directory\n");
	rmSync(join(dir, "dir2"), { recursive: true });
	write(dir, "dir2", "now a file\n");
	chmodSync(join(dir, "run.sh"), 0o755);
	unlinkSync(join(dir, "gone.txt"));
	write(dir, "data.bin", BINARY);
	write(dir, "stamp.id", "$Id$\n");
	write(dir, "ünï code.txt", "unicode\n");
}

describe("publish", () => {
	it("publishes git's stored bytes and a tree equal to git write-tree", async () => {
		const { dir, base } = makeRepo();
		editWorkingTree(dir);
		const statusBefore = git(dir, "status", "--porcelain", "-z");
		const indexBefore = sha1(readFileSync(join(dir, ".git/index")));
		const h = harness(dir, base);

		const result = await h.run();
		if ("refused" in result) throw new Error(JSON.stringify(result.refused));

		// The sandbox's repository is untouched.
		expect(git(dir, "status", "--porcelain", "-z")).toBe(statusBefore);
		expect(sha1(readFileSync(join(dir, ".git/index")))).toBe(indexBefore);
		expect(h.sandbox.execs).toHaveLength(1);
		expect(h.sandbox.execs[0]?.opts?.asRunner).toBeFalsy();
		expect(h.sandbox.downloads).toEqual([h.outPath]);

		git(dir, "add", "-A");
		const expectedTree = git(dir, "write-tree");
		expect(result.treeSha).toBe(expectedTree);

		const listing = gitRaw(dir, "ls-tree", "-r", "-z", expectedTree).toString("utf8");
		const expected = new Map<string, Entry>();
		for (const record of listing.split("\0").filter(Boolean)) {
			const [meta, path] = record.split("\t") as [string, string];
			const [mode, , sha] = meta.split(" ") as [string, string, string];
			expected.set(path, { mode, sha });
		}
		expect(Object.fromEntries(h.gh.files(result.treeSha))).toEqual(Object.fromEntries(expected));

		for (const file of result.changedFiles) {
			if (file.sha === null) continue;
			expect(h.gh.blobs.get(file.sha)?.equals(gitRaw(dir, "cat-file", "blob", file.sha))).toBe(true);
		}
		const blobAt = (path: string) => h.gh.blobs.get(expected.get(path)?.sha as string);
		expect(blobAt("a.txt")?.toString()).toBe("hello\nworld\n");
		expect(blobAt("stamp.id")?.toString()).toBe("$Id$\n");
		expect(blobAt("data.bin")?.equals(BINARY)).toBe(true);
		expect(blobAt("ignored/keep.txt")?.toString()).toBe("kept\n");

		const byPath = Object.fromEntries(result.changedFiles.map((f) => [f.path, `${f.status} ${f.mode}`]));
		expect(byPath).toEqual({
			"a.txt": "M 100644",
			"crlf.txt": "A 100644",
			"ignored/keep.txt": "M 100644",
			"app/[slug]/page.tsx": "A 100644",
			conv: "D 000000",
			"conv/inner.txt": "A 100644",
			"dir2/x.txt": "D 000000",
			dir2: "A 100644",
			"run.sh": "M 100755",
			"gone.txt": "D 000000",
			"data.bin": "A 100644",
			"stamp.id": "A 100644",
			"ünï code.txt": "A 100644",
		});

		const treeCall = h.gh.calls.find((c) => c.path === "/trees") as {
			body: { tree: Array<{ sha: string | null }> };
		};
		const entries = treeCall.body.tree;
		const firstWrite = entries.findIndex((e) => e.sha !== null);
		expect(entries.slice(firstWrite).every((e) => e.sha !== null)).toBe(true);

		const commit = h.gh.commits.get(result.commitSha);
		expect(commit?.parents).toEqual([base]);
		expect(commit?.tree).toBe(result.treeSha);
		expect(commit?.body).toMatchObject({
			message: "Implement #7",
			author: IDENTITY,
			committer: IDENTITY,
		});
		expect(h.gh.refs.get("factory/issue-7")).toBe(result.commitSha);
	});

	it("refuses a symlink without exporting any content", async () => {
		const { dir, base } = makeRepo();
		write(dir, "new.txt", "SECRET-NEW-CONTENT\n");
		symlinkSync("/etc/passwd", join(dir, "evil"));
		const h = harness(dir, base);
		expect(refusals(await h.run())).toEqual([{ kind: "symlink", detail: "evil is a symlink", path: "evil" }]);
		expect(readFileSync(h.outPath).includes("SECRET-NEW-CONTENT")).toBe(false);
		expect(h.gh.calls).toEqual([]);
	});

	it("refuses a file over the size limit before its content leaves the sandbox", async () => {
		const { dir, base } = makeRepo();
		write(dir, "big.txt", `${"BIG-CONTENT ".repeat(20)}\n`);
		const h = harness(dir, base);
		expect(refusals(await h.run({ limits: { maxChangedFiles: 50, maxFileBytes: 100 } }))).toEqual([
			{
				kind: "file_too_large",
				detail: "big.txt is 241 bytes; the limit is 100",
				path: "big.txt",
				bytes: 241,
				limit: 100,
			},
		]);
		expect(readFileSync(h.outPath).includes("BIG-CONTENT")).toBe(false);
		expect(h.gh.calls).toEqual([]);
	});

	it("refuses changes under .github/workflows", async () => {
		const { dir, base } = makeRepo();
		write(dir, ".github/workflows/ci.yml", "on: push\n");
		const h = harness(dir, base);
		expect(refusals(await h.run()).map((r) => r.kind)).toEqual(["workflow_file"]);
	});

	it("ignores agent-written repo config such as clean filters", async () => {
		const { dir, base } = makeRepo();
		const marker = join(tmp, `filter-ran-${++counter}`);
		git(dir, "config", "filter.evil.clean", `touch ${marker}; cat`);
		write(dir, ".gitattributes", "*.txt filter=evil\n");
		write(dir, "new.txt", "x\n");
		const h = harness(dir, base);
		const result = await h.run();
		expect("commitSha" in result).toBe(true);
		expect(() => readFileSync(marker)).toThrow();
	});
});

describe("publish against a subverted sandbox", () => {
	/** Builds a parentless commit whose tree is the base tree plus an `evil` symlink. */
	function forgedBase(dir: string, base: string): { commit: string; tree: string } {
		const env = { ...GIT_ENV, GIT_INDEX_FILE: join(dir, ".git/forged-index") };
		const run = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: dir,
				env,
				encoding: "utf8",
				input: "/etc/passwd",
			}).trim();
		run("read-tree", base);
		const link = execFileSync("git", ["hash-object", "-w", "--stdin"], {
			cwd: dir,
			env,
			input: "/etc/passwd",
		})
			.toString()
			.trim();
		run("update-index", "--add", "--cacheinfo", `120000,${link},evil`);
		const tree = run("write-tree");
		return { commit: run("commit-tree", tree, "-m", "forged"), tree };
	}

	it("ignores git replace on the base commit", async () => {
		const { dir, base } = makeRepo();
		const h = harness(dir, base);
		symlinkSync("/etc/passwd", join(dir, "evil"));
		write(dir, "a.txt", "changed\n");
		const forged = forgedBase(dir, base);
		git(dir, "replace", "-f", base, forged.commit);
		expect(git(dir, "rev-parse", `${base}^{tree}`)).toBe(forged.tree);

		expect(refusals(await h.run()).map((r) => r.kind)).toEqual(["symlink"]);
	});

	it("rejects a blob whose bytes don't match its SHA", async () => {
		const { dir, base } = makeRepo();
		write(dir, "new.txt", "original content\n");
		const h = harness(dir, base);
		h.sandbox.tamper = (file) => Buffer.from(file.toString("latin1").replace("original", "tampered"), "latin1");
		await expect(h.run()).rejects.toThrow(/Blob hash mismatch/);
		expect(h.gh.calls).toEqual([]);
	});

	it("throws when GitHub's base differs from the sandbox's, before creating a ref", async () => {
		const { dir, base } = makeRepo();
		write(dir, "new.txt", "x\n");
		const h = harness(dir, base);
		const baseTree = h.gh.commits.get(base)?.tree as string;
		h.gh.files(baseTree).set("extra.txt", {
			mode: "100644",
			sha: blobSha(Buffer.from("extra\n")),
		});
		await expect(h.run()).rejects.toThrow(/Tree mismatch/);
		expect(h.gh.refs.size).toBe(0);
	});
});

describe("publish branch handling", () => {
	function setup() {
		const { dir, base } = makeRepo();
		write(dir, "new.txt", "x\n");
		return { base, h: harness(dir, base) };
	}

	it("refuses to move a branch that points at someone else's commit", async () => {
		const { base, h } = setup();
		const foreign = "1".repeat(40);
		h.gh.commits.set(foreign, {
			tree: h.gh.commits.get(base)?.tree as string,
			parents: [base],
			body: null,
		});
		h.gh.refs.set("factory/issue-7", foreign);
		await expect(h.run()).rejects.toThrow(/Refusing to move refs\/heads\/factory\/issue-7/);
		expect(h.gh.refs.get("factory/issue-7")).toBe(foreign);
		expect(h.gh.calls.some((c) => c.method === "PATCH")).toBe(false);
	});

	it("is idempotent on retry with a fixed commit date", async () => {
		const { h } = setup();
		const first = await h.run();
		const second = await h.run();
		if ("refused" in first || "refused" in second) throw new Error("refused");
		expect(second.commitSha).toBe(first.commitSha);
		expect(h.gh.calls.filter((c) => c.path === "/refs")).toHaveLength(1);
	});
});
