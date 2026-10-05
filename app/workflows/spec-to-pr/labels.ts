import { factoryConfig } from "../../../factory.config.js";
import type { WorkflowResult } from "../../contracts/index.js";
import type { GitHub, RepoRef } from "../../github/index.js";

const STATUS_PREFIX = "factory-status:";

/** All trigger labels that must never be removed by status-label cleanup. */
const TRIGGER_LABELS = new Set([
	factoryConfig.labels.triage,
	factoryConfig.labels.fullRun,
	factoryConfig.labels.specApproved,
	factoryConfig.labels.prReview,
]);

/** Where a run is, and how it ended. Visible on the issue while it works. */
export const STATUS = {
	analyzing: `${STATUS_PREFIX}analyzing`,
	implementing: `${STATUS_PREFIX}implementing`,
	reviewing: `${STATUS_PREFIX}reviewing`,
	prOpen: `${STATUS_PREFIX}pr-open`,
	needsDetail: `${STATUS_PREFIX}needs-detail`,
	noChanges: `${STATUS_PREFIX}no-changes`,
	changesRequested: `${STATUS_PREFIX}changes-requested`,
	failed: `${STATUS_PREFIX}failed`,
} as const;

export type FactoryStatus = (typeof STATUS)[keyof typeof STATUS];

export function isStatusLabel(label: string): boolean {
	return label.startsWith(STATUS_PREFIX);
}

/** True when this label is a trigger label that must never be auto-removed. */
export function isTriggerLabel(label: string): boolean {
	return TRIGGER_LABELS.has(label);
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
	for (const label of currentLabels.filter(
		(l) => isStatusLabel(l) && !isTriggerLabel(l),
	)) {
		await gh
			.removeLabel(repo, issueNumber, label)
			.catch((error) =>
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
