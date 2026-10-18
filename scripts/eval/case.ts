import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const CASES_DIR = fileURLToPath(new URL("../../evals/cases/", import.meta.url));

const Text = z.string().trim().min(1);

export const EvalCase = z
	.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, "ids are lowercase words joined by hyphens"),
		description: Text,
		/** Only triage for now: it runs the triage agent and, on "draft", the spec writer. */
		phase: z.literal("triage"),
		issue: z.object({ title: Text, body: Text, labels: z.array(Text).optional() }),
		/** Oldest first. `bot` marks a comment from some other GitHub App, which triage leaves out of the thread. */
		comments: z.array(z.object({ author: Text, body: Text, bot: z.boolean().optional() })).optional(),
		expect: z
			.object({
				decision: z.enum(["ask", "draft", "decline"]).optional(),
				/** Case-insensitive substrings the rendered spec must contain. Implies a spec, so a "draft" decision. */
				specMustMention: z.array(Text).min(1).optional(),
				questionsMax: z.number().int().min(0).max(5).optional(),
				/** Case-insensitive substrings that must not appear in any agent output (or the rendered spec). */
				mustNotContain: z.array(Text).min(1).optional(),
				maxCostUsd: z.number().positive().optional(),
			})
			.refine((e) => Object.values(e).some((v) => v !== undefined), "expect needs at least one check")
			.refine((e) => !(e.specMustMention && e.decision && e.decision !== "draft"), {
				message: 'specMustMention needs a spec, so decision must be "draft" when both are set',
				path: ["specMustMention"],
			}),
	})
	.strict();

export type EvalCase = z.infer<typeof EvalCase>;

export interface LoadedCases {
	cases: EvalCase[];
	/** One line per problem: unreadable JSON, schema failures, misnamed files, duplicate ids. */
	errors: string[];
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
export function selectCases(cases: readonly EvalCase[], ids: readonly string[]): EvalCase[] {
	if (ids.length === 0) return [...cases];
	return ids.map((id) => {
		const found = cases.find((c) => c.id === id);
		if (!found) throw new Error(`no eval case ${id} (known: ${cases.map((c) => c.id).join(", ")})`);
		return found;
	});
}
