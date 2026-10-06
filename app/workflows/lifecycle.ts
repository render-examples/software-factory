import { type TaskContext, task } from "@renderinc/sdk/workflows";
import { z } from "zod";
import { factoryConfig } from "../../factory.config.js";
import { repository } from "../config/index.js";
import type { GitHub } from "../github/index.js";
import { githubFromEnv } from "../github/index.js";
import { redactSecrets } from "../policy/index.js";
import {
	finishRun,
	getRun,
	heartbeat,
	markStarted,
	setRunStage,
	type CreateRunInput,
	type RunRecord,
} from "../store/index.js";
import { isBudgetExceeded } from "../tasks/index.js";
import { point, startSpan, type SpanHandle } from "../telemetry/index.js";
import { STATUS, statusLabeler, type FactoryStatus } from "./labels.js";

const runIdSchema = z.object({ runId: z.string().min(1).max(300) });

const HEARTBEAT_INTERVAL_MS = 30_000;

const PERMISSION_RANK: Record<string, number> = {
	none: 0,
	read: 1,
	triage: 2,
	write: 3,
	maintain: 4,
	admin: 5,
};

export class RunCancelled extends Error {
	constructor() {
		super("Run was cancelled");
		this.name = "RunCancelled";
	}
}

export interface LifecycleContext {
	ctx: TaskContext;
	run: RunRecord;
	gh: GitHub;
	stage(name: string): Promise<void>;
	setStatus(status: FactoryStatus): Promise<void>;
	throwIfCancelled(): Promise<void>;
	defer(fn: () => Promise<void>): void;
}

export interface LifecycleResult {
	status: "completed" | "failed" | "cancelled";
	outcome: string;
	result?: Record<string, unknown>;
	comment?: { body: string; operationId: string };
	followUp?: CreateRunInput;
	removeLabels?: string[];
}

/**
 * Register a workflow through the common lifecycle. Handles claiming,
 * heartbeating, permission checks, trigger validation, deferred cleanup,
 * terminal comments, label removal, and error handling.
 */
export function runWorkflow(
	name: string,
	options: { timeoutSeconds?: number; plan?: string },
	handler: (lc: LifecycleContext) => Promise<LifecycleResult>,
) {
	return task(
		{
			name,
			plan: (options.plan ?? "standard") as "standard",
			timeoutSeconds: options.timeoutSeconds ?? 24 * 60 * 60,
		},
		async function lifecycleTask(
			ctx: TaskContext,
			rawInput: unknown,
		): Promise<unknown> {
			const { runId } = runIdSchema.parse(rawInput);

			const claimed = await markStarted(runId);
			if (!claimed) {
				const existing = await getRun(runId);
				return existing?.result ?? { duplicate: true };
			}

			await point(runId, "run.started", { workflow: name });

			const run = await getRun(runId);
			if (!run) throw new Error(`Run ${runId} not found after claiming`);

			const heartbeatTimer = setInterval(async () => {
				try {
					await heartbeat(runId);
				} catch (err) {
					console.error(`lifecycle: heartbeat failed for ${runId}:`, err);
				}
			}, HEARTBEAT_INTERVAL_MS);

			const deferred: Array<() => Promise<void>> = [];
			const repo = repository();
			const gh = githubFromEnv();
			const setStatus = statusLabeler(gh, repo, run.subjectNumber);

			// Track the open stage span so it can be closed when the next
			// stage starts or when the handler finishes.
			let activeStageSpan: SpanHandle | undefined;

			async function endActiveStageSpan(): Promise<void> {
				if (activeStageSpan) {
					const span = activeStageSpan;
					activeStageSpan = undefined;
					await span.end();
				}
			}

			try {
				const trigger = run.trigger as Record<string, unknown> | null;
				const triggerLabel = trigger?.label as string | undefined;
				const actorLogin = (trigger?.actor as { login?: string })?.login;

				// Fail closed: no actor → rejected.
				if (!actorLogin) {
					await finishRun(runId, "completed", {
						outcome: "rejected",
						summary: "No actor login in the trigger",
					});
					if (triggerLabel) {
						await removeLabelQuietly(gh, repo, run, triggerLabel);
					}
					await setStatus(STATUS.failed);
					await point(runId, "run.rejected", { reason: "no_actor" });
					return { status: "rejected" };
				}

				const permission = await gh.getPermission(repo, actorLogin);
				const required = factoryConfig.minimumPermission;
				if (
					(PERMISSION_RANK[permission] ?? 0) < (PERMISSION_RANK[required] ?? 0)
				) {
					const commentBody = `This run was rejected because @${actorLogin} does not have the required \`${required}\` permission on this repository (current: \`${permission}\`).`;
					await ensureComment(
						gh,
						repo,
						run,
						`${runId.slice(0, 64)}-rejected`,
						commentBody,
					);
					await finishRun(runId, "completed", {
						outcome: "rejected",
						summary: `Insufficient permission: ${permission} < ${required}`,
					});
					if (triggerLabel) {
						await removeLabelQuietly(gh, repo, run, triggerLabel);
					}
					await setStatus(STATUS.failed);
					await point(runId, "run.rejected", {
						actor: actorLogin,
						permission,
						required,
					});
					return { status: "rejected" };
				}

				if (triggerLabel && trigger?.event !== "issue_comment") {
					const issue = await gh.getIssue(repo, run.subjectNumber);
					if (!issue.labels.includes(triggerLabel)) {
						await finishRun(runId, "completed", {
							outcome: "trigger_removed",
							summary: `Trigger label "${triggerLabel}" is no longer present`,
						});
						return { status: "trigger_removed" };
					}
				}

				const lc: LifecycleContext = {
					ctx,
					run,
					gh,
					async stage(stageName: string): Promise<void> {
						await endActiveStageSpan();
						await setRunStage(runId, stageName);
						activeStageSpan = await startSpan(runId, "stage", {
							stage: stageName,
						});
					},
					setStatus,
					async throwIfCancelled(): Promise<void> {
						const current = await getRun(runId);
						if (current?.cancelRequestedAt) {
							throw new RunCancelled();
						}
					},
					defer(fn: () => Promise<void>): void {
						deferred.push(fn);
					},
				};

				const result = await handler(lc);

				// End the last stage span before terminal events.
				await endActiveStageSpan();

				// If the handler provided a follow-up without an actor,
				// copy the current trigger's actor so the permission check
				// applies to the human who started the chain.
				const followUp = result.followUp
					? ensureFollowUpActor(result.followUp, trigger)
					: undefined;

				await finishRun(runId, result.status, {
					outcome: result.outcome,
					result: result.result,
					followUp,
				});

				if (result.comment) {
					await ensureComment(
						gh,
						repo,
						run,
						result.comment.operationId,
						result.comment.body,
					);
				}

				const labelsToRemove =
					result.removeLabels ?? (triggerLabel ? [triggerLabel] : []);
				for (const label of labelsToRemove) {
					await removeLabelQuietly(gh, repo, run, label);
				}

				const terminalLabel = mapOutcomeToStatus(result.outcome);
				if (terminalLabel) {
					await setStatus(terminalLabel);
				}

				await point(runId, `run.${result.status}`, {
					outcome: result.outcome,
				});

				return result.result ?? { status: result.outcome };
			} catch (err) {
				// End the last stage span before error handling.
				await endActiveStageSpan();

				const trigger = run.trigger as Record<string, unknown> | null;
				const triggerLabel = trigger?.label as string | undefined;

				if (isBudgetExceeded(err)) {
					await finishRun(runId, "completed", {
						outcome: "budget_exceeded",
						summary: err instanceof Error ? err.message : "Budget exceeded",
					});
					await ensureComment(
						gh,
						repo,
						run,
						`${runId.slice(0, 64)}-budget`,
						"This run was stopped because the per-run cost budget was reached.",
					);
					if (triggerLabel) {
						await removeLabelQuietly(gh, repo, run, triggerLabel);
					}
					await setStatus(STATUS.failed);
					await point(runId, "run.completed", {
						outcome: "budget_exceeded",
					});
					return { status: "budget_exceeded" };
				}

				if (err instanceof RunCancelled) {
					await finishRun(runId, "cancelled", {
						outcome: "cancelled",
						summary: "Run was cancelled by user",
					});
					await ensureComment(
						gh,
						repo,
						run,
						`${runId.slice(0, 64)}-cancelled`,
						"This run was cancelled.",
					);
					if (triggerLabel) {
						await removeLabelQuietly(gh, repo, run, triggerLabel);
					}
					await setStatus(STATUS.failed);
					await point(runId, "run.cancelled");
					return { status: "cancelled" };
				}

				const rawMessage = err instanceof Error ? err.message : String(err);
				const summary = redactSecrets(rawMessage).slice(0, 1000);
				await finishRun(runId, "failed", {
					outcome: "error",
					summary,
				}).catch((storeErr) =>
					console.error("lifecycle: failed to record run failure:", storeErr),
				);

				const publicUrl = process.env.FACTORY_PUBLIC_URL?.trim();
				const runLink = publicUrl
					? `\n\n[View run details](${publicUrl}/runs/${runId})`
					: "";
				await ensureComment(
					gh,
					repo,
					run,
					`${runId.slice(0, 64)}-error`,
					`The run failed with an error.${runLink}`,
				).catch((commentErr) =>
					console.error("lifecycle: failed to post error comment:", commentErr),
				);

				// Remove the trigger label on failure (§3.4).
				if (triggerLabel) {
					await removeLabelQuietly(gh, repo, run, triggerLabel);
				}

				await setStatus(STATUS.failed);
				await point(runId, "run.failed", {
					outcome: "error",
					summary,
				});
				throw err;
			} finally {
				clearInterval(heartbeatTimer);
				for (const fn of deferred.reverse()) {
					try {
						await fn();
					} catch (cleanupErr) {
						console.error("lifecycle: deferred cleanup error:", cleanupErr);
					}
				}
			}
		},
	);
}

async function removeLabelQuietly(
	gh: GitHub,
	repo: { owner: string; repo: string },
	run: RunRecord,
	label: string,
): Promise<void> {
	await gh
		.removeLabel(repo, run.subjectNumber, label)
		.catch((err) =>
			console.error(`lifecycle: failed to remove label ${label}:`, err),
		);
}

async function ensureComment(
	gh: GitHub,
	repo: { owner: string; repo: string },
	run: RunRecord,
	operationId: string,
	body: string,
): Promise<void> {
	try {
		await gh.ensureIssueComment(repo, run.subjectNumber, operationId, body);
	} catch (err) {
		console.error("lifecycle: failed to post comment:", err);
	}
}

/**
 * If the follow-up run's trigger has no actor, copy the actor from the
 * current run's trigger so the permission check in the next lifecycle
 * applies to the human who started the chain.
 */
function ensureFollowUpActor(
	followUp: CreateRunInput,
	currentTrigger: Record<string, unknown> | null,
): CreateRunInput {
	if (!followUp.trigger || !currentTrigger?.actor) return followUp;
	const followUpTrigger = followUp.trigger as Record<string, unknown>;
	if (followUpTrigger.actor) return followUp;
	return {
		...followUp,
		trigger: { ...followUpTrigger, actor: currentTrigger.actor },
	};
}

function mapOutcomeToStatus(outcome: string): FactoryStatus | undefined {
	switch (outcome) {
		case "draft_pr_opened":
		case "pr_opened":
			return STATUS.prOpen;
		case "review_submitted":
			return STATUS.reviewing;
		case "needs_clarification":
		case "asked":
		case "spec_drafted":
			return STATUS.needsDetail;
		case "no_changes":
			return STATUS.noChanges;
		case "changes_requested":
		case "verification_failed":
			return STATUS.changesRequested;
		case "rejected":
		case "error":
		case "dispatch_failed":
		case "execution_lost":
		case "cancelled":
		case "budget_exceeded":
			return STATUS.failed;
		default:
			return undefined;
	}
}
