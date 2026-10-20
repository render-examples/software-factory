import { AgentError } from "../../agents/index.js";
import type { Implementation, ImplementationReview, Spec } from "../../schemas/index.js";
import { renderSpecSections } from "../../format/index.js";
import { RunError } from "../../runs/index.js";
import { failureReport, type VerifyRun } from "./verify.js";

/** An agent that stopped before submitting is an expected failure; its message stays off GitHub. */
export function agentStopped(err: unknown, who: string): RunError | null {
	if (!(err instanceof AgentError)) return null;
	const reason = err.code === "budget_exceeded" ? "reached its soft budget threshold" : `stopped before finishing (\`${err.code}\`)`;
	return new RunError(`the ${who} ${reason}, so no PR was opened.`, "agent_failed");
}

export interface IssueRef {
	number: number;
	title: string;
}

export function implementMessage(issue: IssueRef, spec: Spec): string {
	return `Implement the approved spec for issue #${issue.number}: ${issue.title}\n\n${renderSpecSections(spec)}`;
}

export function repairMessage(issue: IssueRef, spec: Spec, runs: readonly VerifyRun[], round: number, rounds: number): string {
	return `${implementMessage(issue, spec)}\n\n${failureReport(runs)}\n\nThis is repair round ${round} of ${rounds}.`;
}

export function revisionMessage(issue: IssueRef, spec: Spec, review: ImplementationReview): string {
	const issues = review.issues.map((i) => `- ${i.file}${i.line ? `:${i.line}` : ""}: ${i.problem}`).join("\n");
	return [
		implementMessage(issue, spec),
		"## Implementation review issues",
		"A reviewer read your change and found these problems. Your earlier changes are in the working tree: fix these without restructuring the implementation, then run the verify commands again.",
		issues,
	].join("\n\n");
}

export function implementationReviewMessage(issue: IssueRef, spec: Spec, implementation: Implementation): string {
	return `${implementMessage(issue, spec)}\n\n## The implementation agent's summary\n\n${implementation.summary}`;
}

/**
 * Folds a repair or revision submission into the first one. The first summary describes the whole change, so it
 * stays; files and follow-ups accumulate.
 */
export function mergeImplementation(first: Implementation, next: Implementation): Implementation {
	return {
		summary: first.summary,
		filesChanged: [...new Set([...first.filesChanged, ...next.filesChanged])],
		verification: next.verification,
		followUps: [...new Set([...first.followUps, ...next.followUps])].slice(0, 20),
	};
}

/** What the PR body shows when implementation review didn't finish. Verification passed, so the run still publishes. */
export function implementationReviewSkipped(err: AgentError): ImplementationReview {
	return { needsRevision: false, issues: [], notes: [`Implementation review did not finish (${err.code}); review the change in full.`] };
}
