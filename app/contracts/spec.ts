import { z } from "zod";

export const acceptanceCriterionSchema = z.object({
	id: z.string().min(1),
	text: z.string().min(1),
	verification: z.enum(["automated", "ux", "manual"]),
});

export const specSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	problem: z.string(),
	goals: z.array(z.string()),
	nonGoals: z.array(z.string()),
	acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
	approach: z.string(),
	affectedAreas: z.array(z.object({ path: z.string(), change: z.string() })),
	testPlan: z.string(),
	risks: z.array(z.string()),
	assumptions: z.array(z.string()),
	openQuestions: z.array(z.string()),
});

/** What Triage learned, kept with each version so later rounds skip the research. */
export const specNotesSchema = z.object({
	findings: z.string(),
	relevantPaths: z.array(z.string()),
});

export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
export type Spec = z.infer<typeof specSchema>;
export type SpecNotes = z.infer<typeof specNotesSchema>;

export interface SpecValidation {
	errors: string[];
	warnings: string[];
}

/**
 * Rules the schema cannot express. Paths that do not exist yet are warnings,
 * not errors, because a spec may legitimately add new files.
 */
export function validateSpec(
	spec: Spec,
	existingPaths?: ReadonlySet<string>,
): SpecValidation {
	const errors: string[] = [];
	const warnings: string[] = [];

	const ids = spec.acceptanceCriteria.map((criterion) => criterion.id);
	const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
	if (duplicates.length > 0) {
		errors.push(
			`Duplicate acceptance criterion IDs: ${[...new Set(duplicates)].join(", ")}`,
		);
	}

	if (existingPaths) {
		for (const area of spec.affectedAreas) {
			if (!existingPaths.has(area.path)) {
				warnings.push(`${area.path} does not exist yet`);
			}
		}
	}

	return { errors, warnings };
}
