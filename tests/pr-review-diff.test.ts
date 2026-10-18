import { describe, expect, it } from "vitest";
import { commentable, parseDiffLines, patchLines } from "../app/workflows/pr-review/diff-lines.js";

const lines = (diff: string, path: string) => [...(parseDiffLines(diff).get(path) ?? [])];

describe("parseDiffLines", () => {
	it("collects added and context lines on the right side across several hunks", () => {
		const diff = [
			"diff --git a/src/app.ts b/src/app.ts",
			"index 1111111..2222222 100644",
			"--- a/src/app.ts",
			"+++ b/src/app.ts",
			"@@ -1,3 +1,4 @@ function main() {",
			" one",
			"+two",
			" three",
			" four",
			"@@ -20,4 +21,3 @@",
			" twenty",
			"-gone",
			"-also gone",
			"+replaced",
			" end",
			"",
		].join("\n");
		expect(lines(diff, "src/app.ts")).toEqual([1, 2, 3, 4, 21, 22, 23]);
		const ok = commentable(parseDiffLines(diff));
		expect(ok("src/app.ts", 2)).toBe(true);
		expect(ok("src/app.ts", 5)).toBe(false);
		expect(ok("src/app.ts", 24)).toBe(false);
		expect(ok("src/other.ts", 1)).toBe(false);
	});

	it("keys renames by the new path and gives a pure rename no lines", () => {
		const diff = [
			"diff --git a/old/name.ts b/new/name.ts",
			"similarity index 90%",
			"rename from old/name.ts",
			"rename to new/name.ts",
			"index 1111111..2222222 100644",
			"--- a/old/name.ts",
			"+++ b/new/name.ts",
			"@@ -5,2 +5,2 @@",
			"-before",
			"+after",
			" kept",
			"diff --git a/a.txt b/b.txt",
			"similarity index 100%",
			"rename from a.txt",
			"rename to b.txt",
		].join("\n");
		const parsed = parseDiffLines(diff);
		expect([...(parsed.get("new/name.ts") ?? [])]).toEqual([5, 6]);
		expect(parsed.has("old/name.ts")).toBe(false);
		expect(parsed.has("b.txt")).toBe(false);
	});

	it("gives deleted files no right side and still parses the next file", () => {
		const diff = [
			"diff --git a/old.txt b/old.txt",
			"deleted file mode 100644",
			"index 1111111..0000000",
			"--- a/old.txt",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			"-a",
			"-b",
			"diff --git a/new.txt b/new.txt",
			"new file mode 100644",
			"index 0000000..1111111",
			"--- /dev/null",
			"+++ b/new.txt",
			"@@ -0,0 +1,2 @@",
			"+x",
			"+y",
		].join("\n");
		const parsed = parseDiffLines(diff);
		expect(parsed.has("old.txt")).toBe(false);
		expect([...(parsed.get("new.txt") ?? [])]).toEqual([1, 2]);
	});

	it("ignores `\\ No newline at end of file` markers", () => {
		const diff = [
			"diff --git a/f.txt b/f.txt",
			"--- a/f.txt",
			"+++ b/f.txt",
			"@@ -1,2 +1,2 @@",
			" a",
			"-b",
			"\\ No newline at end of file",
			"+b",
			"\\ No newline at end of file",
			"diff --git a/g.txt b/g.txt",
			"--- a/g.txt",
			"+++ b/g.txt",
			"@@ -3 +3 @@",
			"-x",
			"+y",
		].join("\n");
		expect(lines(diff, "f.txt")).toEqual([1, 2]);
		expect(lines(diff, "g.txt")).toEqual([3]);
	});

	it("uses hunk counts, so removed or added lines that look like headers stay content", () => {
		const diff = [
			"diff --git a/sql.sql b/sql.sql",
			"--- a/sql.sql",
			"+++ b/sql.sql",
			"@@ -1,2 +1,2 @@",
			"--- a comment",
			"+++ b/not-a-file",
			" select 1;",
		].join("\n");
		const parsed = parseDiffLines(diff);
		expect([...(parsed.get("sql.sql") ?? [])]).toEqual([1, 2]);
		expect(parsed.has("not-a-file")).toBe(false);
	});

	it("treats a blank line inside a hunk as context", () => {
		const diff = ["--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " a", "", "-c", "+C"].join("\n");
		expect(lines(diff, "f")).toEqual([1, 2, 3]);
	});

	it("unquotes C-style paths and strips the tab after names with spaces", () => {
		const diff = [
			'diff --git "a/caf\\303\\251 \\"x\\".md" "b/caf\\303\\251 \\"x\\".md"',
			'--- "a/caf\\303\\251 \\"x\\".md"',
			'+++ "b/caf\\303\\251 \\"x\\".md"',
			"@@ -1 +1 @@",
			"-a",
			"+b",
			"diff --git a/my file.txt b/my file.txt",
			"--- a/my file.txt\t",
			"+++ b/my file.txt\t",
			"@@ -1 +1,2 @@",
			" a",
			"+b",
		].join("\n");
		const parsed = parseDiffLines(diff);
		expect([...(parsed.get('café "x".md') ?? [])]).toEqual([1]);
		expect([...(parsed.get("my file.txt") ?? [])]).toEqual([1, 2]);
	});
});

describe("patchLines", () => {
	it("parses per-file patches from the list-files API and skips removed and binary files", () => {
		const parsed = patchLines([
			{
				filename: "a.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				changes: 1,
				patch: "@@ -1,2 +1,3 @@\n x\n+y\n z",
			},
			{
				filename: "gone.ts",
				status: "removed",
				additions: 0,
				deletions: 1,
				changes: 1,
				patch: "@@ -1 +0,0 @@\n-x",
			},
			{
				filename: "img.png",
				status: "added",
				additions: 0,
				deletions: 0,
				changes: 0,
			},
		]);
		expect([...(parsed.get("a.ts") ?? [])]).toEqual([1, 2, 3]);
		expect(parsed.has("gone.ts")).toBe(false);
		expect(parsed.has("img.png")).toBe(false);
	});
});
