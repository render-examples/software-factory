import { z } from "zod";

export const triageDecisionSchema = z.object({
	decision: z.enum(["ask", "draft", "decline"]),
	questions: z.array(z.string()),
	rationale: z.string(),
	findings: z.string(),
	relevantPaths: z.array(z.string()),
});

export type TriageDecision = z.infer<typeof triageDecisionSchema>;
