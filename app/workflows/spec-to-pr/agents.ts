import { AgentError } from "../../agents/index.js";
import type { RepoContext } from "../../config/index.js";
import type { Implementation, Spec } from "../../schemas/index.js";
import { renderSpecSections } from "../../format/index.js";
import { RunError } from "../../runs/index.js";
import { failureReport, type VerifyRun } from "./verify.js";

/** An agent that stopped before submitting is an expected failure; its message stays off GitHub. */
export function agentStopped(err: unknown, who: string): RunError | null {
	if (!(err instanceof AgentError)) return null;
	return new RunError(`the ${who} stopped before finishing (\`${err.code}\`), so no PR was opened.`, "agent_failed");
}

export interface IssueRef {
	number: number;
	title: string;
}

export function implementMessage(repo: RepoContext, issue: IssueRef, spec: Spec): string {
	const verify = repo.config.verify.length
		? repo.config.verify.map((command) => `- ${codeSpan(command)}`).join("\n")
		: "- (none configured: check your work by reading it and running the relevant tests)";
	return [
		`Implement the approved spec for issue #${issue.number} in ${repo.fullName}: ${issue.title}`,
		renderSpecSections(spec),
		`## Verify commands\n\n${verify}`,
	].join("\n\n");
}

/** A Markdown code span that shows `text` verbatim, whatever backticks it contains. */
function codeSpan(text: string): string {
	const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longestRun + 1);
	return longestRun > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

export function repairMessage(repo: RepoContext, issue: IssueRef, spec: Spec, runs: readonly VerifyRun[], round: number, rounds: number): string {
	return `${implementMessage(repo, issue, spec)}\n\n${failureReport(runs)}\n\nThis is repair round ${round} of ${rounds}.`;
}

/**
 * Folds a repair submission into the first one. The first summary describes the whole change, so it stays; files
 * and follow-ups accumulate.
 */
export function mergeImplementation(first: Implementation, next: Implementation): Implementation {
	return {
		summary: first.summary,
		filesChanged: [...new Set([...first.filesChanged, ...next.filesChanged])],
		verification: next.verification,
		followUps: [...new Set([...first.followUps, ...next.followUps])].slice(0, 20),
	};
}
