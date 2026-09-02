/** Every way a run can end. Persisted as the run's status in Postgres. */
export type WorkflowResult =
	| { status: "needs_clarification"; questions: string[] }
	| { status: "no_changes" }
	| { status: "changes_requested"; summary: string }
	| { status: "draft_pr_opened"; pullRequest: string };
