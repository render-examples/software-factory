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
import { point, startSpan } from "../telemetry/index.js";
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

			try {
				const trigger = run.trigger as Record<string, unknown> | null;
				const actorLogin = (trigger?.actor as { login?: string })?.login;
				if (actorLogin) {
					const permission = await gh.getPermission(repo, actorLogin);
					const required = factoryConfig.minimumPermission;
					if (
						(PERMISSION_RANK[permission] ?? 0) <
						(PERMISSION_RANK[required] ?? 0)
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
						await point(runId, "run.rejected", {
							actor: actorLogin,
							permission,
							required,
						});
						return { status: "rejected" };
					}
				}

				if (trigger?.label && trigger.event !== "issue_comment") {
					const issue = await gh.getIssue(repo, run.subjectNumber);
					const triggerLabel = trigger.label as string;
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
						await setRunStage(runId, stageName);
						const span = await startSpan(runId, "stage", {
							stage: stageName,
						});
						deferred.push(() => span.end());
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

				await finishRun(runId, result.status, {
					outcome: result.outcome,
					result: result.result,
					followUp: result.followUp,
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
					result.removeLabels ??
					(trigger?.label ? [trigger.label as string] : []);
				for (const label of labelsToRemove) {
					await gh
						.removeLabel(repo, run.subjectNumber, label)
						.catch((err) =>
							console.error(`lifecycle: failed to remove label ${label}:`, err),
						);
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
				if (err instanceof RunCancelled) {
					await finishRun(runId, "cancelled", {
						outcome: "cancelled",
						summary: "Run was cancelled by user",
					});
					const trigger = run.trigger as Record<string, unknown> | null;
					const triggerLabel = trigger?.label as string | undefined;
					await ensureComment(
						gh,
						repo,
						run,
						`${runId.slice(0, 64)}-cancelled`,
						"This run was cancelled.",
					);
					if (triggerLabel) {
						await gh
							.removeLabel(repo, run.subjectNumber, triggerLabel)
							.catch((e) =>
								console.error("lifecycle: failed to remove trigger label:", e),
							);
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

function mapOutcomeToStatus(outcome: string): FactoryStatus | undefined {
	switch (outcome) {
		case "draft_pr_opened":
		case "pr_opened":
			return STATUS.prOpen;
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
			return STATUS.failed;
		default:
			return undefined;
	}
}
