import { randomUUID } from "node:crypto";
import { factoryConfig } from "../../../factory.config.js";
import { repository } from "../../config/index.js";
import type { Spec, SpecNotes } from "../../contracts/index.js";
import {
	triageQuestionsComment,
	triageDeclineComment,
	renderSpecMarkdown,
} from "../../format/index.js";
import type { IssueComment } from "../../github/index.js";
import { listTrackedFiles } from "../../git/index.js";
import {
	createSpec,
	addSpecVersion,
	getCurrentSpec,
	getSpecVersion,
	supersedeSpec,
	type SpecRecord,
	type SpecVersionRecord,
} from "../../store/index.js";
import { lease, release } from "../../workspaces/index.js";
import { runWorkflow, type LifecycleResult } from "../lifecycle.js";
import { assess } from "./assess.js";
import { draft } from "./draft.js";
import { postSpecComment } from "./comment.js";

const FACTORY_MARKER = "<!-- render-factory:";

/** A human comment: not a bot author and no factory marker. */
function isHumanComment(c: IssueComment): boolean {
	return c.authorType !== "Bot" && !c.body.includes(FACTORY_MARKER);
}

/**
 * Newest human comment ID in a list, or undefined.
 * IDs are numeric so we compare as numbers.
 */
function newestHumanId(comments: IssueComment[]): number | undefined {
	let max: number | undefined;
	for (const c of comments) {
		if (isHumanComment(c) && (max === undefined || c.id > max)) {
			max = c.id;
		}
	}
	return max;
}

export const triageWorkflow = runWorkflow(
	"triage",
	{ timeoutSeconds: 60 * 60 },
	async (lc) => {
		const repo = repository();
		const fullName = `${repo.owner}/${repo.repo}`;
		const issueNumber = lc.run.subjectNumber;
		const input = (lc.run.input ?? {}) as Record<string, unknown>;
		const autoAdvance = input.autoAdvance === true;
		const trigger = (lc.run.trigger ?? {}) as Record<string, unknown>;
		const triggerEvent = trigger.event as string | undefined;
		const triggerLabel = trigger.label as string | undefined;

		// ── intake ──────────────────────────────────────────────
		await lc.stage("intake");

		const issue = await lc.gh.getIssue(repo, issueNumber);
		const comments = await lc.gh.listIssueComments(repo, issueNumber);

		// The newest human comment ID THIS round read — used for
		// both spec storage and the follow-up check.
		const newestReadId = newestHumanId(comments);

		let spec: SpecRecord | null = await getCurrentSpec(fullName, issueNumber);
		let latestVersion: SpecVersionRecord | null = null;
		let currentSpec: Spec | undefined;
		let currentNotes: SpecNotes | undefined;

		if (spec && spec.currentVersion > 0) {
			latestVersion = await getSpecVersion(spec.id, spec.currentVersion);
			if (latestVersion) {
				currentSpec = latestVersion.document as unknown as Spec;
				currentNotes = latestVersion.notes as unknown as SpecNotes | undefined;
			}
		}

		// If the current spec is approved and this is a fresh label trigger,
		// supersede it and start a new spec.
		const isLabelTrigger =
			triggerEvent === "issues" && triggerLabel !== undefined;
		if (spec?.status === "approved" && isLabelTrigger) {
			await supersedeSpec(spec.id);
			spec = null;
			latestVersion = null;
			currentSpec = undefined;
			currentNotes = undefined;
		}

		await lc.throwIfCancelled();

		// ── workspace ───────────────────────────────────────────
		await lc.stage("workspace");

		const target = factoryConfig.repos[0];
		const workspace = await lease(lc.run.id, {
			kind: "branch",
			name: target.baseBranch,
		});
		lc.defer(() => release(lc.run.id));

		await lc.throwIfCancelled();

		// ── assess ──────────────────────────────────────────────
		await lc.stage("assess");

		const decision = await assess(lc.ctx, {
			issue,
			comments,
			currentSpec,
			currentNotes,
			sandboxId: workspace.sandbox.id,
			runId: lc.run.id,
		});

		await lc.throwIfCancelled();

		// List tracked files for path validation.
		const existingPaths = await listTrackedFiles(workspace.sandbox);

		// ── act on the decision ─────────────────────────────────
		let result: LifecycleResult;

		if (decision.decision === "ask") {
			await lc.stage("ask");

			result = {
				status: "completed",
				outcome: "asked",
				comment: {
					body: triageQuestionsComment(decision.questions),
					operationId: `${lc.run.id.slice(0, 64)}-questions`,
				},
				removeLabels: [],
			};
		} else if (decision.decision === "draft") {
			await lc.stage("draft");

			const draftResult = await draft(lc.ctx, {
				issue,
				comments,
				findings: decision.findings,
				relevantPaths: decision.relevantPaths,
				previousSpec: currentSpec,
				previousNotes: currentNotes ?? undefined,
				sandboxId: workspace.sandbox.id,
				runId: lc.run.id,
				existingPaths,
			});

			const lastCommentId =
				newestReadId !== undefined ? String(newestReadId) : undefined;

			// Create or reuse the spec row.
			let specId: string;
			if (!spec) {
				specId = randomUUID();
				await createSpec({ id: specId, repo: fullName, issueNumber });
			} else {
				specId = spec.id;
			}

			const version = await addSpecVersion({
				specId,
				document: draftResult.spec as unknown as Record<string, unknown>,
				markdown: renderSpecMarkdown(draftResult.spec),
				notes: draftResult.notes as unknown as Record<string, unknown>,
				lastCommentId,
				runId: lc.run.id,
			});

			// Remove approval label if present (spec B-04).
			const issueLabels = issue.labels;
			const approvalLabel = factoryConfig.labels.specApproved;
			const hadApproval = issueLabels.includes(approvalLabel);
			if (hadApproval) {
				await lc.gh.removeLabel(repo, issueNumber, approvalLabel);
			}

			await postSpecComment({
				gh: lc.gh,
				repo,
				issueNumber,
				specId,
				spec: draftResult.spec,
				version,
				validation: draftResult.validation,
				changeSummary: draftResult.changeSummary,
				approvalRemoved: hadApproval,
			});

			result = {
				status: "completed",
				outcome: "spec_drafted",
				result: { specId, version },
				removeLabels: [],
			};
		} else {
			// decline
			await lc.stage("decline");

			result = {
				status: "completed",
				outcome: "declined",
				comment: {
					body: triageDeclineComment(decision.rationale),
					operationId: `${lc.run.id.slice(0, 64)}-declined`,
				},
				// Default label handling removes the trigger label.
			};
		}

		// ── follow-up round (spec B-03) ─────────────────────────
		// Re-fetch comments to catch anything posted during the run.
		const freshComments = await lc.gh.listIssueComments(repo, issueNumber);
		const newestOnIssueId = newestHumanId(freshComments);

		const conversationOpen =
			result.outcome === "asked" || result.outcome === "spec_drafted";

		if (
			conversationOpen &&
			newestOnIssueId !== undefined &&
			newestReadId !== undefined &&
			newestOnIssueId > newestReadId
		) {
			result.followUp = {
				id: randomUUID(),
				repo: fullName,
				subjectKind: "issue",
				subjectNumber: issueNumber,
				workflow: "triage",
				input: { autoAdvance },
				previousRunId: lc.run.id,
				trigger: {
					event: "follow_up",
					label: triggerLabel,
				},
			};
		}

		return result;
	},
);
