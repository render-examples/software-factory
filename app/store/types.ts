export type RunStatus =
	| "running"
	| "draft_pr_opened"
	| "needs_clarification"
	| "no_changes"
	| "changes_requested"
	| "failed";

export interface RunRecord {
	id: string;
	deliveryId: string;
	issueNumber: number;
	status: RunStatus;
	branch: string | null;
	pullRequest: string | null;
	summary: string | null;
	createdAt: string;
	updatedAt: string;
}
