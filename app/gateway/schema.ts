import { z } from "zod";

export const issueEventSchema = z.object({
	action: z.string(),
	issue: z.object({
		number: z.number().int().positive(),
		labels: z
			.array(z.object({ name: z.string() }))
			.optional()
			.default([]),
		pull_request: z.unknown().optional(),
	}),
	label: z.object({ name: z.string() }).optional(),
	repository: z.object({ full_name: z.string() }),
	sender: z.object({
		login: z.string(),
		id: z.number().int(),
		type: z.string().optional(),
	}),
});

export type IssueEvent = z.infer<typeof issueEventSchema>;

export const issueCommentEventSchema = z.object({
	action: z.string(),
	issue: z.object({
		number: z.number().int().positive(),
		labels: z
			.array(z.object({ name: z.string() }))
			.optional()
			.default([]),
		pull_request: z.unknown().optional(),
	}),
	comment: z.object({
		id: z.number().int(),
		body: z.string(),
		author_association: z.string(),
		user: z.object({
			login: z.string(),
			id: z.number().int(),
			type: z.string().optional(),
		}),
	}),
	repository: z.object({ full_name: z.string() }),
	sender: z.object({
		login: z.string(),
		id: z.number().int(),
		type: z.string().optional(),
	}),
});

export type IssueCommentEvent = z.infer<typeof issueCommentEventSchema>;

export const pullRequestEventSchema = z.object({
	action: z.string(),
	pull_request: z.object({
		number: z.number().int().positive(),
		head: z.object({ sha: z.string() }),
	}),
	label: z.object({ name: z.string() }).optional(),
	repository: z.object({ full_name: z.string() }),
	sender: z.object({
		login: z.string(),
		id: z.number().int(),
		type: z.string().optional(),
	}),
});

export type PullRequestEvent = z.infer<typeof pullRequestEventSchema>;
