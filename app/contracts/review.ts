import { z } from "zod";

const severitySchema = z.enum(["critical", "high", "medium", "low"]);

export const specialistFindingSchema = z.object({
	path: z.string(),
	line: z.number().int().min(1),
	severity: severitySchema,
	confidence: z.number().int().min(0).max(100),
	title: z.string(),
	body: z.string(),
	evidence: z.string(),
});

export const specialistOutputSchema = z.object({
	findings: z.array(specialistFindingSchema),
});

export const synthesisCommentSchema = z.object({
	path: z.string(),
	line: z.number().int().min(1),
	body: z.string(),
});

/** The synthesizer summarizes; it never approves or requests changes. */
export const synthesisSchema = z.object({
	summary: z.string(),
	riskTier: z.enum(["trivial", "low", "medium", "high"]),
	comments: z.array(synthesisCommentSchema),
});

export type SpecialistFinding = z.infer<typeof specialistFindingSchema>;
export type SpecialistOutput = z.infer<typeof specialistOutputSchema>;
export type SynthesisComment = z.infer<typeof synthesisCommentSchema>;
export type Synthesis = z.infer<typeof synthesisSchema>;
