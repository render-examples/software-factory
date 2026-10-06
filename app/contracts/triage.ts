import { z } from "zod";

/** Legacy schema kept for the old pipeline until M7 removes it. */
export const triageSchema = z.object({
	hasEnoughDetail: z.boolean(),
	questions: z.array(z.string()),
	rationale: z.string(),
});

export type Triage = z.infer<typeof triageSchema>;

/** New triage decision output for the phase-model triage workflow. */
export const triageDecisionSchema = z.object({
	decision: z.enum(["ask", "draft", "decline"]),
	questions: z.array(z.string()),
	rationale: z.string(),
	findings: z.string(),
	relevantPaths: z.array(z.string()),
});

export type TriageDecision = z.infer<typeof triageDecisionSchema>;
