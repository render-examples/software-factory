import { z } from "zod";

export const triageSchema = z.object({
	hasEnoughDetail: z.boolean(),
	questions: z.array(z.string()),
	rationale: z.string(),
});

export type Triage = z.infer<typeof triageSchema>;
