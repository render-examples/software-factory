import { z } from "zod";

/** Only the fields the gateway actually decides on. */
export const issueEventSchema = z.object({
	action: z.string(),
	issue: z.object({
		number: z.number().int().positive(),
		pull_request: z.unknown().optional(),
	}),
	label: z.object({ name: z.string() }).optional(),
	repository: z.object({ full_name: z.string() }),
	sender: z.object({ login: z.string(), type: z.string().optional() }),
});

export type IssueEvent = z.infer<typeof issueEventSchema>;
