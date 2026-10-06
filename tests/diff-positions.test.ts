import { describe, expect, it } from "vitest";
import {
	parseDiffHunks,
	validateCommentPositions,
} from "../app/workflows/pr-review/diff-positions.js";

const SAMPLE_DIFF = `diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -10,6 +10,8 @@ import { foo } from "./foo.js";
 const x = 1;
 const y = 2;
+const z = 3;
+const w = 4;
 
 export function main() {
@@ -30,4 +32,5 @@ export function helper() {
   return true;
 }
+export function newHelper() { return false; }
 
diff --git a/src/utils.ts b/src/utils.ts
new file mode 100644
--- /dev/null
+++ b/src/utils.ts
@@ -0,0 +1,5 @@
+export function util() {
+  return 42;
+}
+
+export const CONSTANT = "hello";
`;

describe("parseDiffHunks", () => {
	it("extracts hunks with right-side ranges", () => {
		const hunks = parseDiffHunks(SAMPLE_DIFF);
		expect(hunks).toEqual([
			{ path: "src/index.ts", newStart: 10, newCount: 8 },
			{ path: "src/index.ts", newStart: 32, newCount: 5 },
			{ path: "src/utils.ts", newStart: 1, newCount: 5 },
		]);
	});

	it("handles empty diff", () => {
		expect(parseDiffHunks("")).toEqual([]);
	});

	it("parses single-line hunk (no count)", () => {
		const diff = `--- a/f.ts
+++ b/f.ts
@@ -1 +1 @@
-old
+new`;
		const hunks = parseDiffHunks(diff);
		expect(hunks).toEqual([{ path: "f.ts", newStart: 1, newCount: 1 }]);
	});
});

describe("validateCommentPositions", () => {
	it("accepts comments inside a hunk", () => {
		const { valid, invalid } = validateCommentPositions(
			[
				{ path: "src/index.ts", line: 12, body: "Good" },
				{ path: "src/utils.ts", line: 1, body: "OK" },
			],
			SAMPLE_DIFF,
		);
		expect(valid).toHaveLength(2);
		expect(invalid).toHaveLength(0);
	});

	it("rejects comments outside any hunk", () => {
		const { valid, invalid } = validateCommentPositions(
			[
				{ path: "src/index.ts", line: 100, body: "Outside" },
				{ path: "nonexistent.ts", line: 1, body: "Missing file" },
			],
			SAMPLE_DIFF,
		);
		expect(valid).toHaveLength(0);
		expect(invalid).toHaveLength(2);
	});

	it("splits mixed valid and invalid comments", () => {
		const { valid, invalid } = validateCommentPositions(
			[
				{ path: "src/index.ts", line: 11, body: "In hunk" },
				{ path: "src/index.ts", line: 50, body: "Out of hunk" },
			],
			SAMPLE_DIFF,
		);
		expect(valid).toHaveLength(1);
		expect(valid[0].body).toBe("In hunk");
		expect(invalid).toHaveLength(1);
		expect(invalid[0].body).toBe("Out of hunk");
	});
});
