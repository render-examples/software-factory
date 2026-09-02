import type { WorkflowResult } from "../../contracts/index.js";
import type { GitHub, RepoRef } from "../../github/index.js";

const PREFIX = "factory:";

/** Where a run is, and how it ended. Visible on the issue while it works. */
export const STATUS = {
	analyzing: `${PREFIX}analyzing`,
	implementing: `${PREFIX}implementing`,
	reviewing: `${PREFIX}reviewing`,
	prOpen: `${PREFIX}pr-open`,
	needsDetail: `${PREFIX}needs-detail`,
	noChanges: `${PREFIX}no-changes`,
	changesRequested: `${PREFIX}changes-requested`,
	failed: `${PREFIX}failed`,
} as const;

export type FactoryStatus = (typeof STATUS)[keyof typeof STATUS];

export function isStatusLabel(label: string): boolean {
	return label.startsWith(PREFIX);
}

export function terminalStatus(result: WorkflowResult): FactoryStatus {
	switch (result.status) {
		case "draft_pr_opened":
			return STATUS.prOpen;
		case "needs_clarification":
			return STATUS.needsDetail;
		case "no_changes":
			return STATUS.noChanges;
		case "changes_requested":
			return STATUS.changesRequested;
	}
}

/** Drop status labels left behind by an earlier run on the same issue. */
export async function clearStatusLabels(
	gh: GitHub,
	repo: RepoRef,
	issueNumber: number,
	currentLabels: readonly string[],
): Promise<void> {
	for (const label of currentLabels.filter(isStatusLabel)) {
		await gh.removeLabel(repo, issueNumber, label).catch((error) =>
			console.error(`Failed to clear status label ${label}:`, error),
		);
	}
}

/**
 * Track the run's status label, adding the next one before removing the last
 * so the issue is never briefly unlabeled.
 *
 * Labels are cosmetic, so a failure here is logged and swallowed rather than
 * failing a run that is otherwise fine.
 */
export function statusLabeler(gh: GitHub, repo: RepoRef, issueNumber: number) {
	let current: FactoryStatus | undefined;

	return async function setStatus(next: FactoryStatus): Promise<void> {
		if (current === next) return;
		const previous = current;
		current = next;

		try {
			await gh.addLabels(repo, issueNumber, [next]);
			if (previous) await gh.removeLabel(repo, issueNumber, previous);
		} catch (error) {
			console.error(`Failed to set status label ${next}:`, error);
		}
	};
}
