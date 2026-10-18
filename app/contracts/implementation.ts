import { z } from "zod";

/** One verify command as the implementer ran it. Self-reported: the workflow reruns verify and trusts only its own run. */
export const VerificationRun = z.object({
	command: z.string().min(1),
	passed: z.boolean(),
	notes: z.string().max(2000).describe("What failed and what you did about it, or why you could not run it. Empty when it passed cleanly."),
});

/** The implementer's submission, for a first run and for a repair run alike. */
export const Implementation = z.object({
	summary: z.string().min(1).max(4000).describe("What you changed and why, for the pull request description."),
	filesChanged: z.array(z.string().min(1)).max(500).describe("Repository-relative paths you created, modified, or deleted."),
	verification: z.array(VerificationRun).describe("Every verify command, in order, with its last result."),
	followUps: z.array(z.string().min(1).max(1000)).max(20).describe("Work the spec implies but you left out, for the maintainer."),
});

export const SelfReviewIssue = z.object({
	file: z.string().min(1),
	line: z.number().int().min(1).optional(),
	problem: z.string().min(1).max(2000).describe("The concrete defect and how to fix it."),
});

/** The self-review agent's submission. */
export const SelfReview = z
	.object({
		needsRevision: z.boolean().describe("True only for concrete, fixable problems."),
		issues: z.array(SelfReviewIssue).max(30),
		notes: z.array(z.string().min(1).max(1000)).max(10).describe("Observations for the pull request description that need no fix."),
	})
	.superRefine((value, ctx) => {
		if (value.needsRevision && value.issues.length === 0) {
			ctx.addIssue({ code: "custom", path: ["issues"], message: "needsRevision needs at least one issue" });
		}
	});

export type VerificationRun = z.infer<typeof VerificationRun>;
export type Implementation = z.infer<typeof Implementation>;
export type SelfReviewIssue = z.infer<typeof SelfReviewIssue>;
export type SelfReview = z.infer<typeof SelfReview>;
