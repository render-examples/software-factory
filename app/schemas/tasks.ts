import { z } from "zod";

/** Every task input names its repository and the App installation to act through. */
const RepoInput = z.object({
	repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
	installationId: z.number().int().positive(),
});

const ActorLogin = z.string().min(1);

export const TriageInput = RepoInput.extend({
	issue: z.number().int().positive(),
	actor: ActorLogin,
	/** Set when a human reply started this round. */
	commentId: z.number().int().positive().optional(),
});

export const AutopilotInput = RepoInput.extend({
	issue: z.number().int().positive(),
	actor: ActorLogin,
	/** Set when a human reply restarted an autopilot run that had asked questions. */
	commentId: z.number().int().positive().optional(),
});

export const SpecApproval = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("label"),
		/** When the approval label was applied; the spec must not have changed after it. */
		labeledAt: z.iso.datetime({ offset: true }),
	}),
	z.object({
		kind: z.literal("autopilot"),
		/** The exact App-authored spec returned by the Triage child task. */
		commentId: z.number().int().positive(),
		hash: z.string().regex(/^[0-9a-f]{64}$/),
		version: z.number().int().positive(),
	}),
]);

export const SpecToPrInput = RepoInput.extend({
	issue: z.number().int().positive(),
	actor: ActorLogin,
	approval: SpecApproval,
});

export const PrReviewInput = RepoInput.extend({
	pr: z.number().int().positive(),
	headSha: z.string().regex(/^[0-9a-f]{40}$/),
	actor: ActorLogin,
	/** Keeps an autopilot review under the issue-level root claim. */
	workflowIssue: z.number().int().positive().optional(),
});

export const CancelInput = RepoInput.extend({
	/** Issue or PR number. */
	number: z.number().int().positive(),
	kind: z.enum(["issue", "pr"]),
	actor: ActorLogin,
});

export const RefreshSnapshotInput = RepoInput.extend({
	sha: z.string().regex(/^[0-9a-f]{40}$/),
});

export type TriageInput = z.infer<typeof TriageInput>;
export type AutopilotInput = z.infer<typeof AutopilotInput>;
export type SpecApproval = z.infer<typeof SpecApproval>;
export type SpecToPrInput = z.infer<typeof SpecToPrInput>;
export type PrReviewInput = z.infer<typeof PrReviewInput>;
export type CancelInput = z.infer<typeof CancelInput>;
export type RefreshSnapshotInput = z.infer<typeof RefreshSnapshotInput>;
