import { z } from "zod";

const severitySchema = z.enum(["critical", "high", "medium", "low"]);

export const findingSchema = z.object({
	severity: severitySchema,
	confidence: z.number().int().min(0).max(100),
	file: z.string(),
	description: z.string(),
});

/** Shared by the security, correctness, and tests reviewers. */
export const reviewerOutputSchema = z.object({
	findings: z.array(findingSchema),
});

export const judgeSchema = z.object({
	decision: z.enum(["approve", "request_changes"]),
	riskTier: z.enum(["trivial", "low", "medium", "high"]).optional(),
	summary: z.string(),
	topFindings: z
		.array(
			findingSchema.extend({
				source: z.enum(["security", "correctness", "tests"]),
			}),
		)
		.optional(),
});

export type Finding = z.infer<typeof findingSchema>;
export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;
export type JudgeVerdict = z.infer<typeof judgeSchema>;

/** The judge's verdict plus the rendered reviewer sections it summarized. */
export type Review = JudgeVerdict & { details: string };
