import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_DIR = join(root, "evals", "cases");

const rubricCheckSchema = z.object({
	id: z.string().min(1),
	description: z.string().min(1),
	severity: z.enum(["must", "should", "may"]),
});

const evalCaseSchema = z.object({
	id: z.string().min(1).max(100),
	workflow: z.enum(["triage", "spec-to-pr", "pr-review"]),
	fixture: z.object({
		issueTitle: z.string().min(1),
		issueBody: z.string().min(1),
		labels: z.array(z.string()).optional(),
		comments: z.array(z.string()).optional(),
		prDiff: z.string().optional(),
	}),
	rubric: z.array(rubricCheckSchema).min(1),
	category: z
		.enum([
			"clear-request",
			"underspecified",
			"ux-change",
			"performance",
			"prompt-injection",
		])
		.optional(),
	description: z.string().optional(),
});

describe("eval case schema", () => {
	const files = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json"));

	it("has at least one case file", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		it(`${file} validates against the schema`, () => {
			const raw = readFileSync(join(CASES_DIR, file), "utf8");
			const parsed = JSON.parse(raw);
			const result = evalCaseSchema.safeParse(parsed);
			if (!result.success) {
				const issues = result.error.issues
					.map((i) => `${i.path.join(".")}: ${i.message}`)
					.join("; ");
				throw new Error(`Validation failed: ${issues}`);
			}
		});
	}

	it("all case IDs are unique", () => {
		const ids = new Set<string>();
		for (const file of files) {
			const raw = readFileSync(join(CASES_DIR, file), "utf8");
			const parsed = JSON.parse(raw);
			const result = evalCaseSchema.parse(parsed);
			expect(ids.has(result.id), `Duplicate case ID: ${result.id}`).toBe(false);
			ids.add(result.id);
		}
	});
});
