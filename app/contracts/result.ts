export type WorkflowResult =
	| { status: "needs_clarification"; questions: string[] }
	| { status: "no_changes" }
	| { status: "changes_requested"; summary: string }
	| { status: "draft_pr_opened"; pullRequest: string };
