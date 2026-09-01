/** GitHub-only intake for one configured repository and one trigger label. */
import { Hono } from "hono";
import {
	createHash,
	createHmac,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { FactoryStore } from "#factory/store";
import {
	factoryActors,
	factoryLabel,
	factoryRepository,
} from "../lib/factory-config.js";
import { dispatchWorkflowTask } from "./dispatch.js";
import { readRequestBody } from "./body.js";

const DELIVERY_TTL_SECONDS = 7 * 24 * 60 * 60;
const ISSUE_LEASE_TTL_SECONDS = 26 * 60 * 60;

const issueEventSchema = z.object({
	action: z.string(),
	issue: z.object({
		number: z.number().int().positive(),
		pull_request: z.unknown().optional(),
	}),
	label: z.object({ name: z.string() }).optional(),
	repository: z.object({ full_name: z.string() }),
	sender: z.object({
		login: z.string(),
		type: z.string().optional(),
	}),
});

function verifyGitHubSignature(rawBody: string, headers: Headers): boolean {
	const secret = process.env.GITHUB_WEBHOOK_SECRET;
	if (!secret) return false;
	const signature = headers.get("x-hub-signature-256");
	if (!signature) return false;
	const computed = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
	try {
		return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
	} catch {
		return false;
	}
}

export function githubHandler(options: { store: FactoryStore }): Hono {
	const repository = factoryRepository();
	const triggerLabel = factoryLabel();
	const allowedActors = factoryActors();
	const app = new Hono();

	app.post("/github", async (c) => {
		const rawBody = await readRequestBody(c.req.raw);
		if (rawBody === null) {
			return c.json({ error: "payload too large" }, 413);
		}

		if (!verifyGitHubSignature(rawBody, c.req.raw.headers)) {
			return c.json({ error: "invalid signature" }, 401);
		}

		if (c.req.raw.headers.get("x-github-event") !== "issues") {
			return c.json({ ok: true, ignored: true });
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody);
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
			payload.label?.name !== triggerLabel ||
			payload.repository.full_name.toLowerCase() !==
				repository.fullName.toLowerCase() ||
			payload.issue.pull_request !== undefined ||
			payload.sender.type === "Bot" ||
			!allowedActors.has(payload.sender.login.toLowerCase())
		) {
			return c.json({ ok: true, skipped: true });
		}

		const deliveryId = c.req.raw.headers.get("x-github-delivery");
		if (!deliveryId || !/^[A-Za-z0-9_-]{8,128}$/.test(deliveryId)) {
			return c.json({ error: "missing GitHub delivery ID" }, 400);
		}
		const proposedRunId = randomUUID();
		const subjectKey = `github:${repository.fullName.toLowerCase()}:issue:${payload.issue.number}`;
		let claim: Awaited<ReturnType<FactoryStore["inbox"]["accept"]>>;
		try {
			claim = await options.store.inbox.accept({
				provider: "github",
				deliveryId,
				payloadDigest: createHash("sha256").update(rawBody).digest("hex"),
				subjectKey,
				run: {
					id: proposedRunId,
					rootRunId: proposedRunId,
					kind: "workflow",
					name: "spec-to-pr",
					triggerType: "github.issues.labeled",
					triggerRef: deliveryId,
					input: { issueNumber: payload.issue.number },
				},
				deliveryTtlSeconds: DELIVERY_TTL_SECONDS,
				subjectLeaseTtlSeconds: ISSUE_LEASE_TTL_SECONDS,
			});
		} catch (error) {
			console.error("Failed to claim GitHub delivery:", error);
			return c.json({ error: "intake store unavailable" }, 503);
		}
		if (
			claim.kind === "subject_busy" ||
			claim.kind === "dispatched" ||
			claim.kind === "completed"
		) {
			return c.json({ ok: true, skipped: true, reason: claim.kind });
		}

		const runId = claim.runId;
		await options.store.runs.addLink({
			runId,
			kind: "github.issue",
			externalId: `${repository.fullName}#${payload.issue.number}`,
			metadata: { issueNumber: payload.issue.number },
		});
		const dispatch = await dispatchWorkflowTask("spec-to-pr", {
			issueNumber: payload.issue.number,
			runId,
		});
		if (dispatch.ok) {
			if (dispatch.taskRunId) {
				await options.store.runs.addLink({
					runId,
					kind: "render.workflow-task",
					externalId: dispatch.taskRunId,
				});
			}
			await options.store.inbox.markDispatched("github", deliveryId).catch(
				(error) => console.error("Failed to mark intake dispatched:", error),
			);
			return c.json({ dispatched: "spec-to-pr" }, 202);
		}
		if (claim.kind === "accepted" || claim.kind === "pending") {
			await options.store.inbox
				.abandon("github", deliveryId)
				.catch((error) =>
				console.error("Failed to release intake claim:", error),
			);
		}
		if (dispatch.reason === "no-slug") {
			return c.json({ error: "RENDER_WORKFLOW_SLUG not set" }, 503);
		}
		return c.json({ error: "dispatch failed" }, 502);
	});

	return app;
}
