import { z } from "zod";
import type { Issue } from "../../lib/github.js";

export const inputSchema = z.object({
	issueNumber: z.number().int().positive(),
	runId: z.string().min(1).max(300),
});

export const triageSchema = z.object({
	hasEnoughDetail: z.boolean(),
	questions: z.array(z.string()),
	rationale: z.string(),
});

export const implementationSchema = z.object({
	summary: z.string().min(1),
	verification: z
		.array(
			z.object({
				command: z.string().min(1),
				result: z.string(),
				passed: z.boolean(),
			}),
		)
		.min(1),
});

export const selfReviewSchema = z.object({
	needsRevision: z.boolean(),
	issues: z.array(z.string()),
});

export type SelfReviewResult = z.infer<typeof selfReviewSchema>;

export const findingSeverity = z.enum(["critical", "high", "medium", "low"]);
export type FindingSeverity = z.infer<typeof findingSeverity>;

export const reviewFindingSchema = z.object({
	severity: findingSeverity,
	confidence: z.number().int().min(0).max(100),
	file: z.string(),
	description: z.string(),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewerOutputSchema = z.object({
	findings: z.array(reviewFindingSchema),
});

export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;

export const riskTier = z.enum(["trivial", "low", "medium", "high"]);
export type RiskTier = z.infer<typeof riskTier>;

export const judgeFindingSchema = reviewFindingSchema.extend({
	source: z.enum(["security", "correctness", "tests"]),
});

export type JudgeFinding = z.infer<typeof judgeFindingSchema>;

export const decisionSchema = z.object({
	decision: z.enum(["approve", "request_changes"]),
	riskTier: riskTier.optional(),
	summary: z.string(),
	topFindings: z.array(judgeFindingSchema).optional(),
});

export type TriageResult = z.infer<typeof triageSchema>;
export type ImplementationReport = z.infer<typeof implementationSchema>;
export type ReviewDecision = z.infer<typeof decisionSchema> & {
	details: string;
	topFindings?: z.infer<typeof judgeFindingSchema>[];
};

export interface IntakeCheckpoint {
	issue: Issue;
	workItem: string;
	triage: TriageResult;
}

export interface PendingSandboxCheckpoint {
	id: string;
	ready: false;
}

export interface ReadySandboxCheckpoint {
	id: string;
	ready: true;
	remoteUrl: string;
	remoteHead: string;
	base: string;
	baseSha: string;
	branch: string;
}

export type SandboxCheckpoint =
	| PendingSandboxCheckpoint
	| ReadySandboxCheckpoint;

export interface ImplementationCheckpoint {
	raw: string;
	report: ImplementationReport;
}

export interface CommitCheckpoint {
	sha: string;
}

export interface PullCheckpoint {
	number: number;
	htmlUrl: string;
	headSha: string;
}

export type WorkflowResult =
	| { skipped: string }
	| { status: "needs_clarification"; questions: string[] }
	| { status: "no_changes" }
	| { status: "changes_requested"; summary: string }
	| {
			status: "draft_pr_opened";
			decision: "approve";
			pullRequest: string;
	  };
