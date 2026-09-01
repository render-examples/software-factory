export const SPEC_TO_PR_TASK_NAME = "spec-to-pr";
export const SPEC_TO_PR_TASK_PLAN = "standard";
export const SPEC_TO_PR_MAX_RETRIES = 2;
export const SPEC_TO_PR_MAX_ATTEMPTS = SPEC_TO_PR_MAX_RETRIES + 1;
export const SPEC_TO_PR_RETRY_WAIT_MS = 45_000;
export const SPEC_TO_PR_RETRY_BACKOFF = 2;
export const SPEC_TO_PR_TIMEOUT_SECONDS = 24 * 60 * 60;
export const SPEC_TO_PR_SANDBOX_TIMEOUT_SECONDS = SPEC_TO_PR_TIMEOUT_SECONDS;
export const EXECUTION_HEARTBEAT_INTERVAL_MS = 10_000;
export const EXECUTION_CLAIM_TTL_SECONDS = 30;
export const SUBJECT_LEASE_TTL_SECONDS = 26 * 60 * 60;

export const MAX_ISSUE_CHARS = 12_000;
export const MAX_REVIEW_DIFF_CHARS = 200_000;
export const REPO_DIR = "/home/user/repo";

export const OPERATIONS = {
	clarification: "clarification",
	noChanges: "no-changes",
	verifyFailed: "verify-failed",
	changesRequested: "changes-requested",
	draftPr: "draft-pr",
} as const;

export interface CheckpointStage<Key extends string = string> {
	readonly key: Key;
	readonly replaySafe: boolean;
}

function defineStage<const Key extends string>(
	key: Key,
	replaySafe: boolean,
): CheckpointStage<Key> {
	return { key, replaySafe };
}

export const MAX_VERIFY_ITERATIONS = 3;

export const STAGES = {
	intake: defineStage("intake", false),
	sandbox: defineStage("sandbox", true),
	analysis: defineStage("analysis", false),
	implementation1: defineStage("implementation-1", false),
	commit1: defineStage("commit-1", true),
	verify1: defineStage("verify-1", false),
	verifyFix: defineStage("verify-fix", false),
	verifyFixCommit: defineStage("verify-fix-commit", true),
	selfReview1: defineStage("self-review-1", false),
	selfReviewFix: defineStage("self-review-fix", false),
	selfReviewCommit: defineStage("self-review-commit", true),
	review1: defineStage("review-1", false),
	implementation2: defineStage("implementation-2", false),
	commit2: defineStage("commit-2", true),
	review2: defineStage("review-2", false),
	push: defineStage("push", true),
	pullRequest: defineStage("pull-request", true),
} as const;

export type SpecToPrStage = (typeof STAGES)[keyof typeof STAGES];

const DOWNSTREAM_STAGE_DEFINITIONS = [
	STAGES.analysis,
	STAGES.implementation1,
	STAGES.commit1,
	STAGES.verify1,
	STAGES.verifyFix,
	STAGES.verifyFixCommit,
	STAGES.selfReview1,
	STAGES.selfReviewFix,
	STAGES.selfReviewCommit,
	STAGES.review1,
	STAGES.implementation2,
	STAGES.commit2,
	STAGES.review2,
	STAGES.push,
	STAGES.pullRequest,
] as const;

export const DOWNSTREAM_STAGES: readonly string[] =
	DOWNSTREAM_STAGE_DEFINITIONS.map((stage) => stage.key);
