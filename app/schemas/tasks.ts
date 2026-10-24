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

export const SpecToPrInput = RepoInput.extend({
	issue: z.number().int().positive(),
	actor: ActorLogin,
	/** When the approval label was applied (ISO 8601); the spec must not have changed after it. */
	labeledAt: z.iso.datetime({ offset: true }),
});

export const PrReviewInput = RepoInput.extend({
	pr: z.number().int().positive(),
	headSha: z.string().regex(/^[0-9a-f]{40}$/),
	actor: ActorLogin,
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
export type SpecToPrInput = z.infer<typeof SpecToPrInput>;
export type PrReviewInput = z.infer<typeof PrReviewInput>;
export type CancelInput = z.infer<typeof CancelInput>;
export type RefreshSnapshotInput = z.infer<typeof RefreshSnapshotInput>;
