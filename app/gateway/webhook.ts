import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { factoryConfig } from "../../factory.config.js";
import { repository } from "../config/index.js";
import {
	acceptDelivery,
	getCurrentSpec,
	findActiveRunForSubject,
	recordDelivery,
	requestCancel,
} from "../store/index.js";
import type { SubjectKind } from "../store/index.js";
import { point } from "../telemetry/index.js";
import { readBody } from "./body.js";
import {
	issueCommentEventSchema,
	issueEventSchema,
	pullRequestEventSchema,
} from "./schema.js";
import { verifySignature } from "./signature.js";

const FACTORY_MARKER = "<!-- render-factory:";
const ALLOWED_AUTHOR_ASSOCIATIONS = new Set([
	"OWNER",
	"MEMBER",
	"COLLABORATOR",
]);

/**
 * Build a multiline regex that matches a cancel command on its own line.
 * The prefix is regex-escaped so `/factory` is matched literally.
 */
function buildCancelPattern(prefix: string): RegExp {
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^\\s*${escaped}\\s+cancel\\s*$`, "m");
}

export function githubWebhook(): Hono {
	const repo = repository();
	const labels = factoryConfig.labels;
	const cancelPattern = buildCancelPattern(factoryConfig.commandPrefix);
	const app = new Hono();

	app.post("/webhooks/github", async (c) => {
		const body = await readBody(c.req.raw);
		if (body === null) {
			return c.json({ error: "payload too large" }, 413);
		}
		if (!verifySignature(body, c.req.raw.headers)) {
			return c.json({ error: "invalid signature" }, 401);
		}

		const deliveryId = c.req.raw.headers.get("x-github-delivery");
		if (!deliveryId || !/^[A-Za-z0-9_-]{8,128}$/.test(deliveryId)) {
			return c.json({ error: "missing GitHub delivery ID" }, 400);
		}

		const event = c.req.raw.headers.get("x-github-event") ?? "unknown";

		if (event === "issues") {
			return handleIssueEvent(c, body, deliveryId, repo, labels);
		}
		if (event === "issue_comment") {
			return handleIssueCommentEvent(
				c,
				body,
				deliveryId,
				repo,
				labels,
				cancelPattern,
			);
		}
		if (event === "pull_request") {
			return handlePullRequestEvent(c, body, deliveryId, repo, labels);
		}

		await recordDelivery({
			deliveryId,
			event,
			action: "unknown",
			outcome: "ignored",
		});
		return c.json({ ok: true, ignored: true }, 202);
	});

	return app;
}

async function handleIssueEvent(
	c: { json: (data: unknown, status?: number) => Response },
	body: string,
	deliveryId: string,
	repo: ReturnType<typeof repository>,
	labels: typeof factoryConfig.labels,
): Promise<Response> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}
	const result = issueEventSchema.safeParse(parsed);
	if (!result.success) {
		return c.json({ error: "invalid payload" }, 400);
	}

	const payload = result.data;

	if (
		payload.action !== "labeled" ||
		!payload.label ||
		payload.repository.full_name.toLowerCase() !==
			`${repo.owner}/${repo.repo}`.toLowerCase() ||
		payload.issue.pull_request !== undefined ||
		payload.sender.type === "Bot"
	) {
		await recordDelivery({
			deliveryId,
			event: "issues",
			action: payload.action,
			outcome: "ignored",
			detail: { reason: "filter_mismatch" },
		});
		return c.json({ ok: true, ignored: true }, 202);
	}

	const labelName = payload.label.name;
	const trigger = {
		deliveryId,
		event: "issues" as const,
		action: "labeled" as const,
		label: labelName,
		actor: { login: payload.sender.login, id: payload.sender.id },
	};

	if (labelName === labels.triage) {
		return createRun(c, deliveryId, repo, {
			subjectKind: "issue",
			subjectNumber: payload.issue.number,
			workflow: "triage",
			trigger,
			input: { autoAdvance: false },
		});
	}

	if (labelName === labels.fullRun) {
		return createRun(c, deliveryId, repo, {
			subjectKind: "issue",
			subjectNumber: payload.issue.number,
			workflow: "triage",
			trigger,
			input: { autoAdvance: true },
		});
	}

	if (labelName === labels.specApproved) {
		const spec = await getCurrentSpec(
			`${repo.owner}/${repo.repo}`,
			payload.issue.number,
		);
		const issueLabels = payload.issue.labels.map((l) => l.name);
		const autoAdvance = issueLabels.includes(labels.fullRun);
		return createRun(c, deliveryId, repo, {
			subjectKind: "issue",
			subjectNumber: payload.issue.number,
			workflow: "spec-to-pr",
			trigger,
			input: {
				specId: spec?.id ?? null,
				specVersion: spec?.currentVersion ?? null,
				autoAdvance,
			},
		});
	}

	await recordDelivery({
		deliveryId,
		event: "issues",
		action: "labeled",
		outcome: "ignored",
		detail: { reason: "unrecognized_label", label: labelName },
	});
	return c.json({ ok: true, ignored: true }, 202);
}

async function handleIssueCommentEvent(
	c: { json: (data: unknown, status?: number) => Response },
	body: string,
	deliveryId: string,
	repo: ReturnType<typeof repository>,
	labels: typeof factoryConfig.labels,
	cancelPattern: RegExp,
): Promise<Response> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}
	const result = issueCommentEventSchema.safeParse(parsed);
	if (!result.success) {
		return c.json({ error: "invalid payload" }, 400);
	}

	const payload = result.data;

	// Basic filters: must be "created", correct repo, not a bot.
	if (
		payload.action !== "created" ||
		payload.repository.full_name.toLowerCase() !==
			`${repo.owner}/${repo.repo}`.toLowerCase() ||
		payload.sender.type === "Bot"
	) {
		await recordDelivery({
			deliveryId,
			event: "issue_comment",
			action: payload.action,
			outcome: "ignored",
			detail: { reason: "filter_mismatch" },
		});
		return c.json({ ok: true, ignored: true }, 202);
	}

	const isPr = payload.issue.pull_request !== undefined;
	const subjectKind: SubjectKind = isPr ? "pull_request" : "issue";

	// Check for cancel command before other filters. This allows
	// cancel on both issue and PR comments.
	if (cancelPattern.test(payload.comment.body)) {
		if (ALLOWED_AUTHOR_ASSOCIATIONS.has(payload.comment.author_association)) {
			const fullName = `${repo.owner}/${repo.repo}`;
			const activeRun = await findActiveRunForSubject(
				fullName,
				subjectKind,
				payload.issue.number,
			);
			if (activeRun) {
				await requestCancel(activeRun.id);
			}
			await recordDelivery({
				deliveryId,
				event: "issue_comment",
				action: "created",
				outcome: "accepted",
				detail: {
					reason: "cancel_command",
					runId: activeRun?.id ?? null,
				},
			});
			return c.json(
				{ ok: true, cancel: true, runId: activeRun?.id ?? null },
				202,
			);
		}
		// Non-collaborator cancel → ignored.
		await recordDelivery({
			deliveryId,
			event: "issue_comment",
			action: "created",
			outcome: "ignored",
			detail: {
				reason: "author_association",
				association: payload.comment.author_association,
			},
		});
		return c.json({ ok: true, ignored: true }, 202);
	}

	// Only issue comments (not PR comments) proceed to reply routing.
	if (isPr) {
		await recordDelivery({
			deliveryId,
			event: "issue_comment",
			action: "created",
			outcome: "ignored",
			detail: { reason: "pr_comment_not_cancel" },
		});
		return c.json({ ok: true, ignored: true }, 202);
	}

	if (payload.comment.body.includes(FACTORY_MARKER)) {
		await recordDelivery({
			deliveryId,
			event: "issue_comment",
			action: "created",
			outcome: "ignored",
			detail: { reason: "factory_marker" },
		});
		return c.json({ ok: true, ignored: true }, 202);
	}

	if (!ALLOWED_AUTHOR_ASSOCIATIONS.has(payload.comment.author_association)) {
		await recordDelivery({
			deliveryId,
			event: "issue_comment",
			action: "created",
			outcome: "ignored",
			detail: {
				reason: "author_association",
				association: payload.comment.author_association,
			},
		});
		return c.json({ ok: true, ignored: true }, 202);
	}

	const issueLabels = payload.issue.labels.map((l) => l.name);
	const hasTriageLabel = issueLabels.includes(labels.triage);
	const hasFullRunLabel = issueLabels.includes(labels.fullRun);

	if (!hasTriageLabel && !hasFullRunLabel) {
		await recordDelivery({
			deliveryId,
			event: "issue_comment",
			action: "created",
			outcome: "ignored",
			detail: { reason: "no_conversation_label" },
		});
		return c.json({ ok: true, ignored: true }, 202);
	}

	const autoAdvance = hasFullRunLabel;
	const trigger = {
		deliveryId,
		event: "issue_comment" as const,
		action: "created" as const,
		commentId: payload.comment.id,
		actor: { login: payload.sender.login, id: payload.sender.id },
	};

	return createRun(c, deliveryId, repo, {
		subjectKind: "issue",
		subjectNumber: payload.issue.number,
		workflow: "triage",
		trigger,
		input: { autoAdvance },
	});
}

async function handlePullRequestEvent(
	c: { json: (data: unknown, status?: number) => Response },
	body: string,
	deliveryId: string,
	repo: ReturnType<typeof repository>,
	labels: typeof factoryConfig.labels,
): Promise<Response> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}
	const result = pullRequestEventSchema.safeParse(parsed);
	if (!result.success) {
		return c.json({ error: "invalid payload" }, 400);
	}

	const payload = result.data;

	if (
		payload.action !== "labeled" ||
		!payload.label ||
		payload.label.name !== labels.prReview ||
		payload.repository.full_name.toLowerCase() !==
			`${repo.owner}/${repo.repo}`.toLowerCase() ||
		payload.sender.type === "Bot"
	) {
		await recordDelivery({
			deliveryId,
			event: "pull_request",
			action: payload.action,
			outcome: "ignored",
			detail: { reason: "filter_mismatch" },
		});
		return c.json({ ok: true, ignored: true }, 202);
	}

	const trigger = {
		deliveryId,
		event: "pull_request" as const,
		action: "labeled" as const,
		label: labels.prReview,
		actor: { login: payload.sender.login, id: payload.sender.id },
	};

	return createRun(c, deliveryId, repo, {
		subjectKind: "pull_request",
		subjectNumber: payload.pull_request.number,
		workflow: "pr-review",
		trigger,
		input: {
			prNumber: payload.pull_request.number,
			headSha: payload.pull_request.head.sha,
		},
	});
}

async function createRun(
	c: { json: (data: unknown, status?: number) => Response },
	deliveryId: string,
	repo: ReturnType<typeof repository>,
	opts: {
		subjectKind: "issue" | "pull_request";
		subjectNumber: number;
		workflow: string;
		trigger: Record<string, unknown>;
		input: Record<string, unknown>;
	},
): Promise<Response> {
	const runId = randomUUID();
	const fullName = `${repo.owner}/${repo.repo}`;

	try {
		const result = await acceptDelivery({
			delivery: {
				deliveryId,
				event: String(opts.trigger.event),
				action: String(opts.trigger.action),
				detail: { runId, workflow: opts.workflow },
			},
			run: {
				id: runId,
				repo: fullName,
				subjectKind: opts.subjectKind,
				subjectNumber: opts.subjectNumber,
				workflow: opts.workflow,
				trigger: opts.trigger,
				input: opts.input,
			},
		});

		if (
			result.outcome === "duplicate" ||
			result.outcome === "duplicate_active_run"
		) {
			return c.json({ ok: true, skipped: true }, 202);
		}

		try {
			await point(runId, "run.accepted", {
				deliveryId,
				workflow: opts.workflow,
			});
		} catch {
			/* telemetry must not fail the request */
		}

		return c.json({ queued: opts.workflow, runId }, 202);
	} catch (error) {
		console.error("Failed to accept delivery:", error);
		return c.json({ error: "store unavailable" }, 503);
	}
}
