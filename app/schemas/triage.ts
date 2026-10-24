import { z } from "zod";

/** The triage agent's submission: whether a competent engineer would know what to build. */
export const TriageDecision = z
	.object({
		decision: z
			.enum(["ask", "draft", "decline"])
			.describe('"draft" by default; "ask" only when the intent is unclear; "decline" for spam, duplicates, or out of scope.'),
		questions: z.array(z.string().min(1).max(1000)).max(5).describe('Questions for the maintainer. Non-empty exactly when decision is "ask".'),
		rationale: z.string().min(1).max(4000).describe("Why you decided this. Shown to the maintainer when you decline."),
		findings: z.string().max(8000).describe("What you learned from the repository, kept for the spec writer and later rounds."),
		relevantPaths: z.array(z.string().min(1)).max(50).describe("Repository-relative paths that matter for the change."),
	})
	.superRefine((value, ctx) => {
		if (value.decision === "ask" && value.questions.length === 0) {
			ctx.addIssue({ code: "custom", path: ["questions"], message: 'decision "ask" needs at least one question' });
		}
		if (value.decision !== "ask" && value.questions.length > 0) {
			ctx.addIssue({ code: "custom", path: ["questions"], message: `decision "${value.decision}" takes no questions` });
		}
	});

export type TriageDecision = z.infer<typeof TriageDecision>;
