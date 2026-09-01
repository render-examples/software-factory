import type {
	ExecutionHandle,
	FactoryStore,
} from "#factory/store";
import type { GitHub, RepoRef } from "../../lib/github.js";
import { SPEC_TO_PR_MAX_ATTEMPTS } from "./constants.js";
import type { WorkflowResult } from "./contracts.js";
import { operationId } from "./context.js";

interface FinishOptions {
	store: FactoryStore;
	runId: string;
	execution: ExecutionHandle;
	result: WorkflowResult;
}

export async function finish({
	store,
	runId,
	execution,
	result,
}: FinishOptions): Promise<WorkflowResult> {
	await store.completeRun({
		runId,
		execution,
		status: "completed",
		result,
	});
	return result;
}

interface RecordFailureOptions {
	store: FactoryStore;
	execution: ExecutionHandle;
	gh: GitHub;
	repo: RepoRef;
	issueNumber: number;
	runId: string;
	triggerLabel: string;
}

export async function recordFailure({
	store,
	execution,
	gh,
	repo,
	issueNumber,
	runId,
	triggerLabel,
}: RecordFailureOptions): Promise<boolean> {
	const failureCount = await store.runs.incrementFailureCount(runId, execution);
	if (failureCount < SPEC_TO_PR_MAX_ATTEMPTS) return false;

	await gh
		.ensureIssueComment(
			repo,
			issueNumber,
			operationId(runId, "failed"),
			`The factory run failed after ${SPEC_TO_PR_MAX_ATTEMPTS} attempts. Reapply the \`${triggerLabel}\` label to start a new run.`,
		)
		.catch(() => {});
	await store.completeRun({
		runId,
		execution,
		status: "failed",
		errorCode: "attempts_exhausted",
		result: { status: "failed" },
	});
	return true;
}
