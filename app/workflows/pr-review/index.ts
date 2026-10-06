/** pr-review — COMMENT review on a pull request. */
import { repository, target } from "../../config/index.js";
import { reviewBody } from "../../format/review-body.js";
import { runVerification } from "../../git/verify.js";
import type { CommandResult } from "../../git/types.js";
import type { RepoRef } from "../../github/index.js";
import { GitHubHttp } from "../../github/request.js";
import { githubToken } from "../../github/auth.js";
import type { SpecialistFinding } from "../../contracts/index.js";
import type { UxTestOutput } from "../../contracts/ux.js";
import type { PreviewStatus } from "../../preview/index.js";
import { lease, release } from "../../workspaces/index.js";
import { point } from "../../telemetry/index.js";
import { type LifecycleResult, runWorkflow } from "../lifecycle.js";
import { STATUS } from "../labels.js";

import { intake, type IntakeResult } from "./intake.js";
import { runSpecialists } from "./specialists.js";
import { startLocalDev } from "./local-dev.js";
import { runUxTests } from "./ux.js";
import { waitForPreview } from "./preview.js";
import { synthesize } from "./synthesize.js";
import { submitReview } from "./submit.js";

const WORKFLOW_TIMEOUT = 2 * 60 * 60;

export const prReview = runWorkflow(
	"pr-review",
	{ timeoutSeconds: WORKFLOW_TIMEOUT },
	async (lc): Promise<LifecycleResult> => {
		const { ctx, run, gh, stage, setStatus, throwIfCancelled, defer } = lc;
		const repo: RepoRef = repository();
		const repoTarget = target();
		const runId = run.id;
		const input = run.input as { prNumber?: number; headSha?: string } | null;
		const prNumber = input?.prNumber;
		const headSha = input?.headSha;

		if (!prNumber || !headSha) {
			return {
				status: "failed",
				outcome: "error",
				result: { error: "Missing prNumber or headSha in run input" },
			};
		}

		const http = new GitHubHttp(() => githubToken());

		// ── Intake ──────────────────────────────────────────────────────
		await stage("intake");
		await setStatus(STATUS.reviewing);

		let intakeData: IntakeResult;
		try {
			intakeData = await intake(gh, http, repo, prNumber);
		} catch (err) {
			return {
				status: "failed",
				outcome: "error",
				result: {
					error: `Failed to load PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
				},
			};
		}

		if (intakeData.pull.state === "closed") {
			return {
				status: "completed",
				outcome: "pr_closed",
				result: { prNumber },
			};
		}

		await throwIfCancelled();

		// ── Workspace ───────────────────────────────────────────────────
		await stage("workspace");
		const workspace = await lease(runId, {
			kind: "pull",
			number: prNumber,
			headSha,
		});
		defer(() => release(runId));

		await throwIfCancelled();

		// ── Verify ──────────────────────────────────────────────────────
		await stage("verify");
		const verification = await runVerification(
			workspace.sandbox,
			repoTarget.verify,
		);
		const verificationEvidence = verification.results
			.map(
				(r: CommandResult) =>
					`${r.command}: exit ${r.exitCode} (${r.durationMs}ms)\n${r.outputTail}`,
			)
			.join("\n---\n");

		await point(runId, "verify.complete", {
			passed: verification.passed,
			failureCount: verification.failures ? 1 : 0,
		});

		await throwIfCancelled();

		// ── Specialists ─────────────────────────────────────────────────
		await stage("specialists");
		const diff = intakeData.diff;
		const specialistResults = await runSpecialists(ctx, {
			runId,
			sandboxId: workspace.sandbox.id,
			diff,
			specContext: intakeData.specContext,
			verificationEvidence,
		});

		await throwIfCancelled();

		// ── Local UX ────────────────────────────────────────────────────
		await stage("local-ux");
		let localUxResults: UxTestOutput | null = null;
		let localDevSkipped: string | undefined;

		if (repoTarget.dev) {
			const devResult = await startLocalDev(
				workspace.sandbox,
				runId,
				workspace.repoDir,
			);
			if (devResult.healthy) {
				const criteria = extractUxCriteria(intakeData);
				localUxResults = await runUxTests(ctx, {
					runId,
					sandboxId: workspace.sandbox.id,
					baseUrl: `http://localhost:${devResult.port}${repoTarget.dev.healthPath}`,
					criteria,
				});
			} else {
				localDevSkipped = devResult.skippedReason;
			}
		} else {
			localDevSkipped = "No dev server configured";
		}

		await throwIfCancelled();

		// ── Preview UX ──────────────────────────────────────────────────
		await stage("preview-ux");
		let previewUxResults: UxTestOutput | null = null;
		let previewSkipped: string | undefined;
		let previewStatus: PreviewStatus = { state: "not_configured" };

		if (repoTarget.preview) {
			const previewResult = await waitForPreview({
				headSha,
				prNumber,
			});
			previewStatus = previewResult.status;

			if (previewStatus.state === "live") {
				const criteria = extractUxCriteria(intakeData);
				previewUxResults = await runUxTests(ctx, {
					runId,
					sandboxId: workspace.sandbox.id,
					baseUrl: previewStatus.url,
					criteria,
				});
			} else {
				previewSkipped =
					previewResult.skippedReason ??
					(previewStatus.state === "failed"
						? previewStatus.detail
						: "Preview not ready");
			}
		} else {
			previewSkipped = "No preview environment configured";
		}

		await throwIfCancelled();

		// ── Synthesize ──────────────────────────────────────────────────
		await stage("synthesize");
		const allUxResults = mergeUxResults(localUxResults, previewUxResults);
		const synthesis = await synthesize(ctx, {
			runId,
			diff,
			specialistResults,
			verificationResult: verification,
			uxResults: allUxResults,
		});

		await throwIfCancelled();

		// ── Submit ──────────────────────────────────────────────────────
		await stage("submit");

		const findingsMap = new Map<string, readonly SpecialistFinding[]>();
		for (const sr of specialistResults) {
			findingsMap.set(sr.name, sr.findings);
		}

		const body = reviewBody({
			runId,
			riskTier: synthesis.riskTier,
			summary: synthesis.summary,
			verificationResults: verification.results,
			specialistFindings: findingsMap,
			uxResults: allUxResults?.results ?? [],
			previewStatus,
			localDevSkipped,
			previewSkipped,
		});

		const inlineComments = synthesis.validComments.map((c) => ({
			path: c.path,
			line: c.line,
			body: c.body,
		}));

		const reviewResult = await submitReview(http, repo, {
			runId,
			prNumber,
			headSha,
			body,
			comments: inlineComments,
		});

		await point(runId, "review.submitted", {
			prNumber,
			headSha,
			alreadyExisted: reviewResult.alreadyExisted,
			reviewId: reviewResult.id,
			validComments: synthesis.validComments.length,
			invalidComments: synthesis.invalidComments.length,
		});

		return {
			status: "completed",
			outcome: "review_submitted",
			result: {
				prNumber,
				headSha,
				reviewId: reviewResult.id,
				riskTier: synthesis.riskTier,
			},
		};
	},
);

function extractUxCriteria(intakeData: IntakeResult): string {
	return (
		intakeData.specContext ??
		intakeData.pull.body.slice(0, 5000) ??
		"Test the application"
	);
}

function mergeUxResults(
	local: UxTestOutput | null,
	preview: UxTestOutput | null,
): UxTestOutput | null {
	if (!local && !preview) return null;
	return {
		results: [...(local?.results ?? []), ...(preview?.results ?? [])],
	};
}
