import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Spec } from "../../app/schemas/index.js";

export const CASES_DIR = fileURLToPath(new URL("../../evals/cases/", import.meta.url));
export const FIXTURE_FILE = fileURLToPath(new URL("../../evals/fixture.json", import.meta.url));

const Text = z.string().trim().min(1);
const RelativePath = Text.refine((path) => !path.startsWith("/") && !path.split(/[\\/]/).includes(".."), "must be a relative path without ..");
const Sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a lowercase 40-character commit SHA");

const Common = z.object({
	id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, "ids are lowercase words joined by hyphens"),
	description: Text,
	tags: z.array(Text).max(20).optional(),
});

const SafetyExpect = {
	/** Case-insensitive substrings that must not appear in an agent submission or produced diff. */
	mustNotContain: z.array(Text).min(1).optional(),
	/** Case-insensitive substrings forbidden in any tool call's serialized arguments. */
	forbiddenToolArgs: z.array(Text).min(1).optional(),
	maxCostUsd: z.number().positive().optional(),
};

const ExpectedFinding = z.object({
	file: RelativePath.optional(),
	/** At least one issue/comment must contain every term, case-insensitively. */
	mustMention: z.array(Text).min(1),
});

const TriageCase = Common.extend({
	stage: z.literal("triage"),
	issue: z.object({ title: Text, body: Text, labels: z.array(Text).optional() }),
	/** Oldest first. `bot` marks a comment from some other GitHub App, which triage leaves out of the thread. */
	comments: z.array(z.object({ author: Text, body: Text, bot: z.boolean().optional() })).optional(),
	expect: z
		.object({
			decision: z.enum(["ask", "draft", "decline"]).optional(),
			/** Case-insensitive substrings the rendered spec must contain. Implies a spec, so a "draft" decision. */
			specMustMention: z.array(Text).min(1).optional(),
			questionsMax: z.number().int().min(0).max(5).optional(),
			...SafetyExpect,
		})
		.refine((e) => Object.values(e).some((v) => v !== undefined), "expect needs at least one check")
		.refine((e) => !(e.specMustMention && e.decision && e.decision !== "draft"), {
			message: 'specMustMention needs a spec, so decision must be "draft" when both are set',
			path: ["specMustMention"],
		}),
});

const FixturePatch = z.object({ patch: RelativePath });

const ImplementationCase = Common.extend({
	stage: z.literal("implementation"),
	issue: z.object({ title: Text }),
	spec: Spec,
	expect: z
		.object({
			/** Trusted commands run after the agent; every command must pass. They are not shown to the agent. */
			commands: z.array(Text).min(1).optional(),
			changedFilesMustInclude: z.array(RelativePath).min(1).optional(),
			changedFilesMustNotInclude: z.array(RelativePath).min(1).optional(),
			diffMustMention: z.array(Text).min(1).optional(),
			...SafetyExpect,
		})
		.refine((e) => Object.values(e).some((v) => v !== undefined), "expect needs at least one check"),
});

const ImplementationReviewCase = Common.extend({
	stage: z.literal("implementation-review"),
	fixture: FixturePatch,
	issue: z.object({ title: Text }),
	spec: Spec,
	implementationSummary: Text,
	expect: z.object({
		needsRevision: z.boolean(),
		findings: z.array(ExpectedFinding).optional(),
		maxIssues: z.number().int().nonnegative().optional(),
		...SafetyExpect,
	}),
});

const PrReviewCase = Common.extend({
	stage: z.literal("pr-review"),
	fixture: FixturePatch,
	pull: z.object({ title: Text, body: z.string().max(20_000).default("") }),
	expect: z.object({
		riskTier: z.enum(["trivial", "low", "medium", "high"]).optional(),
		findings: z.array(ExpectedFinding).optional(),
		maxComments: z.number().int().nonnegative().optional(),
		...SafetyExpect,
	}),
});

export const EvalCase = z.discriminatedUnion("stage", [TriageCase, ImplementationCase, ImplementationReviewCase, PrReviewCase]);

export const EvalFixture = z
	.object({
		repo: Text.regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/name"),
		baseBranch: Text,
		sha: Sha,
	})
	.strict();

export type EvalCase = z.infer<typeof EvalCase>;
export type EvalFixture = z.infer<typeof EvalFixture>;
export type EvalStage = EvalCase["stage"];

export interface LoadedCases {
	cases: EvalCase[];
	/** One line per problem: unreadable JSON, schema failures, misnamed files, duplicate ids. */
	errors: string[];
}

/** Loads the immutable target revision shared by the eval suite. */
export async function loadFixture(file: string = FIXTURE_FILE): Promise<EvalFixture> {
	return EvalFixture.parse(JSON.parse(await readFile(file, "utf8")));
}

/** Reads every `*.json` in `dir`, validates it, and checks that each file is named after its case id. */
export async function loadCases(dir: string = CASES_DIR): Promise<LoadedCases> {
	const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
	const cases: EvalCase[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(join(dir, file), "utf8"));
		} catch (error) {
			errors.push(`${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const parsed = EvalCase.safeParse(raw);
		if (!parsed.success) {
			errors.push(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
			continue;
		}
		const c = parsed.data;
		if (file !== `${c.id}.json`) errors.push(`${file}: the file must be named ${c.id}.json`);
		if (seen.has(c.id)) errors.push(`${file}: duplicate case id ${c.id}`);
		seen.add(c.id);
		cases.push(c);
	}
	if (files.length === 0) errors.push(`no case files in ${dir}`);
	return { cases, errors };
}

/** The cases named by `ids`, in that order; an unknown id throws. All cases when `ids` is empty. */
export function selectCases(
	cases: readonly EvalCase[],
	ids: readonly string[],
	options: { stages?: readonly EvalStage[]; tags?: readonly string[] } = {},
): EvalCase[] {
	const selected =
		ids.length === 0
			? [...cases]
			: ids.map((id) => {
		const found = cases.find((c) => c.id === id);
		if (!found) throw new Error(`no eval case ${id} (known: ${cases.map((c) => c.id).join(", ")})`);
		return found;
			});
	const stages = new Set(options.stages ?? []);
	const tags = new Set(options.tags ?? []);
	return selected.filter((c) => (stages.size === 0 || stages.has(c.stage)) && (tags.size === 0 || c.tags?.some((tag) => tags.has(tag))));
}
