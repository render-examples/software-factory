import { z } from "zod";

/** What the gateway dispatches. Deliberately small and JSON-serializable. */
export const workflowInputSchema = z.object({
	issueNumber: z.number().int().positive(),
	runId: z.string().min(1).max(300),
});

export type WorkflowInput = z.infer<typeof workflowInputSchema>;
