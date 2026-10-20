import { z } from "zod";

const Item = z.string().min(1).max(1000);
const Items = (max: number) => z.array(Item).max(max);

export const AcceptanceCriterion = z.object({
	id: z.string().regex(/^AC-[1-9]\d*$/, 'criterion IDs look like "AC-1"'),
	text: z.string().min(1).max(1000),
	/** No browser testing at launch: a criterion is checked by tests or the build, or by a person. */
	verification: z.enum(["automated", "manual"]),
});

export const AffectedArea = z.object({
	path: z.string().min(1).max(300).describe("Repository-relative path. New files are fine; say so in change."),
	change: z.string().min(1).max(1000),
});

export const Spec = z.object({
	title: z.string().min(1).max(200),
	summary: z.string().min(1).max(2000),
	problem: z.string().max(4000),
	goals: Items(20),
	nonGoals: Items(20),
	acceptanceCriteria: z.array(AcceptanceCriterion).min(1).max(30),
	approach: z.string().max(8000),
	affectedAreas: z.array(AffectedArea).max(50),
	testPlan: z.string().max(4000),
	risks: Items(20),
	assumptions: Items(20),
	openQuestions: Items(20),
});

/** What the spec writer learned, kept with the spec so later rounds skip the research. */
export const SpecNotes = z.object({
	findings: z.string().max(8000),
	relevantPaths: z.array(z.string().min(1)).max(50),
});

/** The spec writer's submission. */
export const SpecDraft = z.object({
	spec: Spec,
	notes: SpecNotes,
	changeSummary: z.string().max(2000).optional().describe("Only when revising a previous version: what changed and why."),
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;
export type AffectedArea = z.infer<typeof AffectedArea>;
export type Spec = z.infer<typeof Spec>;
export type SpecNotes = z.infer<typeof SpecNotes>;
export type SpecDraft = z.infer<typeof SpecDraft>;

/** The spec travels as JSON in its comment's hidden marker; past this size it no longer fits beside the rendered spec. */
export const SPEC_MAX_JSON_CHARS = 20_000;

export interface SpecValidation {
	/** The spec can't be posted or implemented as is. */
	errors: string[];
	/** Worth showing the maintainer, but not blocking. */
	warnings: string[];
}

/**
 * Rules the schema can't express. Paths that don't exist yet are warnings, not errors, because a spec may
 * add files; pass `existingPaths` (repository-relative) to check them.
 */
export function validateSpec(spec: Spec, existingPaths?: ReadonlySet<string>): SpecValidation {
	const errors: string[] = [];
	const warnings: string[] = [];

	const ids = spec.acceptanceCriteria.map((c) => c.id);
	const duplicateIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
	if (duplicateIds.length > 0) errors.push(`Duplicate acceptance criterion IDs: ${duplicateIds.join(", ")}`);

	for (const { path } of spec.affectedAreas) {
		if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).includes("..")) {
			errors.push(`${path} is not a repository-relative path`);
		} else if (existingPaths && !existingPaths.has(normalizePath(path))) {
			warnings.push(`${path} does not exist yet`);
		}
	}
	const paths = spec.affectedAreas.map((a) => normalizePath(a.path));
	const duplicatePaths = [...new Set(paths.filter((p, i) => paths.indexOf(p) !== i))];
	if (duplicatePaths.length > 0) warnings.push(`Affected areas list a path more than once: ${duplicatePaths.join(", ")}`);

	const size = JSON.stringify(spec).length;
	if (size > SPEC_MAX_JSON_CHARS) errors.push(`The spec is ${size} characters as JSON; the limit is ${SPEC_MAX_JSON_CHARS}`);

	if (spec.goals.length === 0) warnings.push("The spec lists no goals");
	if (!spec.acceptanceCriteria.some((c) => c.verification === "automated")) {
		warnings.push("No acceptance criterion is automated, so verification can't check any of them");
	}
	if (spec.openQuestions.length > 0) warnings.push(`The spec has ${spec.openQuestions.length} open question(s); answer them before approving`);

	return { errors, warnings };
}

function normalizePath(path: string): string {
	return path.replace(/^\.\//, "").replace(/\/+$/, "");
}
