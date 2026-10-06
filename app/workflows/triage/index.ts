import { randomUUID } from "node:crypto";
import { factoryConfig } from "../../../factory.config.js";
import { repository } from "../../config/index.js";
import type { Spec, SpecNotes } from "../../contracts/index.js";
import {
	triageQuestionsComment,
	triageDeclineComment,
} from "../../format/index.js";
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

export const triageWorkflow = runWorkflow(
	"triage",
	{ timeoutSeconds: 30 * 60 },
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
			});

			// Find the newest human comment ID this round read.
			const humanComments = comments.filter(
				(c) =>
					!c.body.includes(FACTORY_MARKER) && c.user !== "github-actions[bot]",
			);
			const lastCommentId =
				humanComments.length > 0
					? String(humanComments[humanComments.length - 1].id)
					: undefined;

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
				markdown: JSON.stringify(draftResult.spec),
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
		// Compare the newest human comment on the issue with what this round read.
		const humanCommentsNow = comments.filter(
			(c) =>
				!c.body.includes(FACTORY_MARKER) && c.user !== "github-actions[bot]",
		);
		const newestRead =
			latestVersion?.lastCommentId ??
			(humanCommentsNow.length > 0
				? String(humanCommentsNow[humanCommentsNow.length - 1].id)
				: undefined);

		// Re-fetch comments to catch anything posted during the run.
		const freshComments = await lc.gh.listIssueComments(repo, issueNumber);
		const freshHuman = freshComments.filter(
			(c) =>
				!c.body.includes(FACTORY_MARKER) && c.user !== "github-actions[bot]",
		);
		const newestOnIssue =
			freshHuman.length > 0
				? String(freshHuman[freshHuman.length - 1].id)
				: undefined;

		const conversationOpen =
			result.outcome === "asked" || result.outcome === "spec_drafted";

		if (
			conversationOpen &&
			newestOnIssue &&
			newestRead &&
			newestOnIssue !== newestRead
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
