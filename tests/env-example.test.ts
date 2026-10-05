import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extract all variable names defined (or commented) in .env.example.
 * Matches lines like VAR=val, VAR=, and # VAR= (commented-out variables).
 */
async function envExampleVars(): Promise<Set<string>> {
	const content = await readFile(join(root, ".env.example"), "utf8");
	const vars = new Set<string>();
	for (const line of content.split("\n")) {
		const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
		if (m) vars.add(m[1]);
	}
	return vars;
}

/**
 * Scan app/ and scripts/ for process.env.X reads and return the variable names.
 * Deliberately includes commented code so a dead reference is caught.
 */
async function envReadsInSource(): Promise<Set<string>> {
	const { globSync } = await import("node:fs");

	const patterns = [
		join(root, "app", "**", "*.ts"),
		join(root, "scripts", "**", "*.ts"),
	];
	const vars = new Set<string>();
	for (const pattern of patterns) {
		const files = globSync(pattern);
		for (const file of files) {
			const content = await readFile(file, "utf8");
			for (const m of content.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
				vars.add(m[1]);
			}
			for (const m of content.matchAll(
				/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
			)) {
				vars.add(m[1]);
			}
		}
	}
	// NODE_ENV and NO_COLOR are standard runtime variables, not deployment config.
	vars.delete("NODE_ENV");
	vars.delete("NO_COLOR");
	return vars;
}

describe(".env.example completeness", () => {
	it("every process.env read in app/ and scripts/ is listed in .env.example", async () => {
		const documented = await envExampleVars();
		const used = await envReadsInSource();
		const missing = [...used].filter((v) => !documented.has(v)).sort();
		expect(missing, `Missing from .env.example: ${missing.join(", ")}`).toEqual(
			[],
		);
	});
});
