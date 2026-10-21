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

export type VerificationRun = z.infer<typeof VerificationRun>;
export type Implementation = z.infer<typeof Implementation>;
