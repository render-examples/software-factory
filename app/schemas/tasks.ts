import { z } from "zod";
import { SHA } from "../util/index.js";

const RepoInput = z.object({
	repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
	installationId: z.number().int().positive(),
});

const ActorLogin = z.string().min(1);

export const TriageInput = RepoInput.extend({
	issue: z.number().int().positive(),
	actor: ActorLogin,
	commentId: z.number().int().positive().optional(),
});

export const AutopilotInput = RepoInput.extend({
	issue: z.number().int().positive(),
	actor: ActorLogin,
	commentId: z.number().int().positive().optional(),
});

export const SpecApproval = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("label"),
		labeledAt: z.iso.datetime({ offset: true }),
	}),
	z.object({
		kind: z.literal("autopilot"),
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
	headSha: z.string().regex(SHA),
	actor: ActorLogin,
});

export const CancelInput = RepoInput.extend({
	number: z.number().int().positive(),
	kind: z.enum(["issue", "pr"]),
	actor: ActorLogin,
});

export const RefreshSnapshotInput = RepoInput.extend({
	sha: z.string().regex(SHA),
});

export type TriageInput = z.infer<typeof TriageInput>;
export type AutopilotInput = z.infer<typeof AutopilotInput>;
export type SpecApproval = z.infer<typeof SpecApproval>;
export type SpecToPrInput = z.infer<typeof SpecToPrInput>;
export type PrReviewInput = z.infer<typeof PrReviewInput>;
export type CancelInput = z.infer<typeof CancelInput>;
export type RefreshSnapshotInput = z.infer<typeof RefreshSnapshotInput>;
