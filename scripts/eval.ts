/**
 * Eval runner for render-factory.
 *
 * Loads eval cases from evals/cases/*.json, validates them against the
 * EvalCase schema, and prints a run plan. With --live it explains what
 * it would do and exits non-zero if required env is missing.
 *
 *   npm run eval
 *   npm run eval -- --live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { bold, dim, green, red, yellow, heading } from "./support.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(__dirname, "..", "evals", "cases");

// ── Schema ──────────────────────────────────────────────────────────
export const rubricCheckSchema = z.object({
	id: z.string().min(1),
	description: z.string().min(1),
	severity: z.enum(["must", "should", "may"]),
});

export const evalCaseSchema = z.object({
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

export type EvalCase = z.infer<typeof evalCaseSchema>;
export type RubricCheck = z.infer<typeof rubricCheckSchema>;

// ── Load cases ──────────────────────────────────────────────────────
function loadCases(): { cases: EvalCase[]; errors: string[] } {
	const files = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json"));
	const cases: EvalCase[] = [];
	const errors: string[] = [];

	for (const file of files) {
		const raw = readFileSync(join(CASES_DIR, file), "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			errors.push(
				`${file}: invalid JSON — ${e instanceof Error ? e.message : String(e)}`,
			);
			continue;
		}

		const result = evalCaseSchema.safeParse(parsed);
		if (!result.success) {
			const issues = result.error.issues
				.map((i) => `  ${i.path.join(".")}: ${i.message}`)
				.join("\n");
			errors.push(`${file}: schema validation failed\n${issues}`);
			continue;
		}

		cases.push(result.data);
	}

	return { cases, errors };
}

// ── Main ────────────────────────────────────────────────────────────
const { values } = parseArgs({
	options: {
		live: { type: "boolean", default: false },
	},
	allowPositionals: true,
});

heading("Eval cases");

const { cases, errors } = loadCases();

if (errors.length > 0) {
	for (const err of errors) {
		console.log(`  ${red("✗")} ${err}`);
	}
	console.log();
	console.log(red(`${errors.length} case(s) failed validation.`));
	process.exit(1);
}

if (cases.length === 0) {
	console.log(`  ${yellow("!")} No eval cases found in evals/cases/`);
	process.exit(1);
}

console.log(`  ${green("✓")} ${cases.length} case(s) loaded\n`);

heading("Run plan");

for (const c of cases) {
	const checks = c.rubric.length;
	const musts = c.rubric.filter((r) => r.severity === "must").length;
	const category = c.category ? ` [${c.category}]` : "";
	console.log(`  ${bold(c.id)}${category}`);
	console.log(`    workflow: ${c.workflow}`);
	console.log(`    fixture:  issue "${c.fixture.issueTitle}"`);
	console.log(`    rubric:   ${checks} check(s), ${musts} must-pass`);
	if (c.description) {
		console.log(`    ${dim(c.description)}`);
	}
	console.log();
}

if (values.live) {
	heading("Live mode");

	const required = [
		"DATABASE_URL",
		"ANTHROPIC_API_KEY",
		"GITHUB_APP_ID",
		"GITHUB_APP_PRIVATE_KEY",
		"GITHUB_APP_INSTALLATION_ID",
		"RENDER_API_KEY",
		"RENDER_WORKSPACE_ID",
	];

	const missing = required.filter((v) => !process.env[v]?.trim());

	if (missing.length > 0) {
		console.log(
			`  ${red("✗")} Missing required env for live mode: ${missing.join(", ")}`,
		);
		console.log(
			`\n${dim("Live eval calls real workflows against the sample repository.")}`,
		);
		console.log(dim("Set these variables, then run again with --live."));
		process.exit(1);
	}

	console.log(
		`  ${yellow("!")} Live eval would run ${cases.length} case(s) against real services.`,
	);
	console.log(dim("  Live execution is not implemented in 0.1.0."));
	process.exit(0);
}

console.log(
	green("Plan complete. Run with --live to execute against real services."),
);
