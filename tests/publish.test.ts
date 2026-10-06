/**
 * Tests for the publish module: change-set parsing, refusal rules,
 * tar parsing, and the Git Data API sequence.
 */
import { describe, expect, it, vi } from "vitest";
import { parseDiffRaw, checkTotalSize } from "../app/publish/index.js";
import { parseTar } from "../app/publish/tar.js";
import { ensureRef, type GitDataClient } from "../app/github/git-data.js";

describe("parseDiffRaw", () => {
	it("parses additions, modifications, and deletions", () => {
		const raw = [
			":000000 100644 0000000 abc1234 A\0src/new.ts\0",
			":100644 100644 abc1234 def5678 M\0src/changed.ts\0",
			":100644 000000 abc1234 0000000 D\0src/removed.ts\0",
		].join("");

		const entries = parseDiffRaw(raw);
		expect(entries).toHaveLength(3);
		expect(entries[0]).toEqual({
			status: "A",
			path: "src/new.ts",
			mode: "100644",
		});
		expect(entries[1]).toEqual({
			status: "M",
			path: "src/changed.ts",
			mode: "100644",
		});
		expect(entries[2]).toEqual({
			status: "D",
			path: "src/removed.ts",
			mode: "000000",
		});
	});

	it("parses executable file modes", () => {
		const raw = ":000000 100755 0000000 abc1234 A\0scripts/run.sh\0";
		const entries = parseDiffRaw(raw);
		expect(entries[0]?.mode).toBe("100755");
	});

	it("detects symlinks by mode 120000", () => {
		const raw = ":000000 120000 0000000 abc1234 A\0link\0";
		const entries = parseDiffRaw(raw);
		expect(entries[0]?.mode).toBe("120000");
	});

	it("detects submodules by mode 160000", () => {
		const raw = ":000000 160000 0000000 abc1234 A\0vendor/lib\0";
		const entries = parseDiffRaw(raw);
		expect(entries[0]?.mode).toBe("160000");
	});

	it("returns empty array for empty input", () => {
		expect(parseDiffRaw("")).toEqual([]);
	});
});

describe("checkTotalSize", () => {
	it("returns null when within limits", () => {
		const files = new Map([["a.ts", Buffer.from("hello")]]);
		expect(checkTotalSize(files)).toBeNull();
	});

	it("returns a refusal when over 5 MB", () => {
		const files = new Map([["big.bin", Buffer.alloc(6 * 1024 * 1024)]]);
		const result = checkTotalSize(files);
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("too_large");
	});
});

describe("parseTar", () => {
	function makeHeader(opts: {
		name: string;
		size: number;
		type?: number;
	}): Buffer {
		const header = Buffer.alloc(512);
		header.write(opts.name, 0, Math.min(opts.name.length, 100), "utf8");
		header.write("100644", 100, 6, "ascii");
		header.write(`${opts.size.toString(8)}\0`, 124, 12, "ascii");
		header[156] = opts.type ?? 0x30;
		return header;
	}

	it("extracts a single text file", () => {
		const content = Buffer.from("hello world");
		const header = makeHeader({ name: "test.txt", size: content.length });
		const padding = Buffer.alloc(512 - (content.length % 512));
		const end = Buffer.alloc(1024);
		const archive = Buffer.concat([header, content, padding, end]);

		const entries = parseTar(archive);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.path).toBe("test.txt");
		expect(entries[0]?.data.toString("utf8")).toBe("hello world");
	});

	it("handles binary content", () => {
		const content = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01]);
		const header = makeHeader({ name: "binary.bin", size: content.length });
		const padding = Buffer.alloc(512 - (content.length % 512));
		const end = Buffer.alloc(1024);
		const archive = Buffer.concat([header, content, padding, end]);

		const entries = parseTar(archive);
		expect(entries).toHaveLength(1);
		expect(Buffer.compare(entries[0]?.data as Buffer, content)).toBe(0);
	});

	it("skips directories", () => {
		const dirHeader = makeHeader({ name: "src/", size: 0, type: 0x35 });
		const fileContent = Buffer.from("code");
		const fileHeader = makeHeader({
			name: "src/app.ts",
			size: fileContent.length,
		});
		const padding = Buffer.alloc(512 - (fileContent.length % 512));
		const end = Buffer.alloc(1024);
		const archive = Buffer.concat([
			dirHeader,
			fileHeader,
			fileContent,
			padding,
			end,
		]);

		const entries = parseTar(archive);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.path).toBe("src/app.ts");
	});

	it("handles multiple files", () => {
		const a = Buffer.from("aaa");
		const b = Buffer.from("bbb");
		const ha = makeHeader({ name: "a.txt", size: a.length });
		const hb = makeHeader({ name: "b.txt", size: b.length });
		const pad = (content: Buffer) => Buffer.alloc(512 - (content.length % 512));
		const end = Buffer.alloc(1024);
		const archive = Buffer.concat([ha, a, pad(a), hb, b, pad(b), end]);

		const entries = parseTar(archive);
		expect(entries).toHaveLength(2);
	});

	it("handles empty archive", () => {
		const end = Buffer.alloc(1024);
		expect(parseTar(end)).toEqual([]);
	});
});

describe("ensureRef", () => {
	function fakeClient(existing: string | null): GitDataClient {
		return {
			createBlob: vi.fn(),
			createTree: vi.fn(),
			createCommit: vi.fn(),
			getRef: vi.fn().mockResolvedValue(existing),
			createRef: vi.fn(),
		};
	}

	it("creates a new ref when none exists", async () => {
		const client = fakeClient(null);
		await ensureRef(client, "heads/factory/issue-1", "sha123");
		expect(client.createRef).toHaveBeenCalledWith(
			"heads/factory/issue-1",
			"sha123",
		);
	});

	it("succeeds when ref exists at the same SHA", async () => {
		const client = fakeClient("sha123");
		await ensureRef(client, "heads/factory/issue-1", "sha123");
		expect(client.createRef).not.toHaveBeenCalled();
	});

	it("fails closed when ref exists at a different SHA", async () => {
		const client = fakeClient("other-sha");
		await expect(
			ensureRef(client, "heads/factory/issue-1", "sha123"),
		).rejects.toThrow("already exists");
	});
});

describe("Git Data API sequence", () => {
	it("creates blob, tree, commit, ref in the correct order", async () => {
		const callOrder: string[] = [];
		const client: GitDataClient = {
			createBlob: vi.fn().mockImplementation(async () => {
				callOrder.push("blob");
				return "blob-sha";
			}),
			createTree: vi.fn().mockImplementation(async () => {
				callOrder.push("tree");
				return "tree-sha";
			}),
			createCommit: vi.fn().mockImplementation(async () => {
				callOrder.push("commit");
				return "commit-sha";
			}),
			getRef: vi.fn().mockResolvedValue(null),
			createRef: vi.fn().mockImplementation(async () => {
				callOrder.push("ref");
			}),
		};

		await client.createBlob(Buffer.from("content"));
		await client.createTree("base-tree", [
			{ path: "file.ts", mode: "100644", type: "blob", sha: "blob-sha" },
		]);
		await client.createCommit({
			message: "test",
			tree: "tree-sha",
			parents: ["base-sha"],
			author: {
				name: "bot",
				email: "bot@test.dev",
				date: "2026-01-01T00:00:00Z",
			},
			committer: {
				name: "bot",
				email: "bot@test.dev",
				date: "2026-01-01T00:00:00Z",
			},
		});
		await ensureRef(client, "heads/test", "commit-sha");

		expect(callOrder).toEqual(["blob", "tree", "commit", "ref"]);
	});

	it("passes deletions as sha: null in tree entries", async () => {
		const client: GitDataClient = {
			createBlob: vi.fn(),
			createTree: vi.fn().mockResolvedValue("tree-sha"),
			createCommit: vi.fn(),
			getRef: vi.fn(),
			createRef: vi.fn(),
		};

		await client.createTree("base-tree", [
			{ path: "deleted.ts", mode: "100644", type: "blob", sha: null },
		]);

		expect(client.createTree).toHaveBeenCalledWith("base-tree", [
			{ path: "deleted.ts", mode: "100644", type: "blob", sha: null },
		]);
	});

	it("uses deterministic commit dates", async () => {
		const client: GitDataClient = {
			createBlob: vi.fn(),
			createTree: vi.fn(),
			createCommit: vi.fn().mockResolvedValue("sha"),
			getRef: vi.fn(),
			createRef: vi.fn(),
		};

		const fixedDate = "2026-10-05T12:00:00Z";
		await client.createCommit({
			message: "test",
			tree: "tree",
			parents: ["parent"],
			author: { name: "bot", email: "bot@test.dev", date: fixedDate },
			committer: { name: "bot", email: "bot@test.dev", date: fixedDate },
		});

		const call = (client.createCommit as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as Record<string, unknown>;
		expect((call.author as { date: string }).date).toBe(fixedDate);
		expect((call.committer as { date: string }).date).toBe(fixedDate);
	});
});
