import { z } from "zod";

export const uxVerdictSchema = z.enum(["pass", "fail", "inconclusive"]);

export const uxResultSchema = z.object({
	criterionId: z.string().optional(),
	verdict: uxVerdictSchema,
	observations: z.string(),
	screenshotArtifactIds: z.array(z.string()).default([]),
});

export const uxTestOutputSchema = z.object({
	results: z.array(uxResultSchema),
});

export type UxVerdict = z.infer<typeof uxVerdictSchema>;
export type UxResult = z.infer<typeof uxResultSchema>;
export type UxTestOutput = z.infer<typeof uxTestOutputSchema>;
