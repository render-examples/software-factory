import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { allowedActors, repository, triggerLabel } from "../config/index.js";
import { createQueuedRun, finishRun, recordDelivery } from "../store/index.js";
import { readBody } from "./body.js";
import { dispatchWorkflow } from "./dispatch.js";
import { issueEventSchema } from "./schema.js";
import { verifySignature } from "./signature.js";

export function githubWebhook(): Hono {
	const repo = repository();
	const label = triggerLabel();
	const actors = allowedActors();
	const app = new Hono();

	app.post("/webhooks/github", async (c) => {
		const body = await readBody(c.req.raw);
		if (body === null) return c.json({ error: "payload too large" }, 413);
		if (!verifySignature(body, c.req.raw.headers)) {
			return c.json({ error: "invalid signature" }, 401);
		}

		const deliveryId = c.req.raw.headers.get("x-github-delivery");
		if (!deliveryId || !/^[A-Za-z0-9_-]{8,128}$/.test(deliveryId)) {
			return c.json({ error: "missing GitHub delivery ID" }, 400);
		}

		if (c.req.raw.headers.get("x-github-event") !== "issues") {
			await recordDelivery({
				deliveryId,
				event: c.req.raw.headers.get("x-github-event") ?? "unknown",
				action: "unknown",
				outcome: "ignored",
			});
			return c.json({ ok: true, ignored: true });
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const event = issueEventSchema.safeParse(parsed);
		if (!event.success) return c.json({ error: "invalid payload" }, 400);

		const payload = event.data;
		if (
			payload.action !== "labeled" ||
			payload.label?.name !== label ||
			payload.repository.full_name.toLowerCase() !==
				repo.fullName.toLowerCase() ||
			payload.issue.pull_request !== undefined ||
			payload.sender.type === "Bot" ||
			!actors.has(payload.sender.login.toLowerCase())
		) {
			await recordDelivery({
				deliveryId,
				event: "issues",
				action: payload.action,
				outcome: "ignored",
				detail: { reason: "filter_mismatch" },
			});
			return c.json({ ok: true, skipped: true });
		}

		const runId = randomUUID();
		let claimed: boolean;
		try {
			claimed = await createQueuedRun({
				id: runId,
				repo: repo.fullName,
				subjectKind: "issue",
				subjectNumber: payload.issue.number,
				workflow: "spec-to-pr",
				trigger: {
					deliveryId,
					event: "issues",
					label: label,
					actor: payload.sender.login,
				},
			});
		} catch (error) {
			console.error("Failed to create run:", error);
			return c.json({ error: "store unavailable" }, 503);
		}

		if (!claimed) {
			await recordDelivery({
				deliveryId,
				event: "issues",
				action: "labeled",
				outcome: "duplicate_active_run",
				detail: { issueNumber: payload.issue.number },
			});
			return c.json({ ok: true, skipped: true });
		}

		await recordDelivery({
			deliveryId,
			event: "issues",
			action: "labeled",
			outcome: "accepted",
			detail: { runId, issueNumber: payload.issue.number },
		});

		// Gateway still dispatches directly in M2; M3 moves this to the dispatcher.
		const dispatched = await dispatchWorkflow("spec-to-pr", {
			issueNumber: payload.issue.number,
			runId,
		});
		if (!dispatched) {
			await finishRun(runId, "failed", {
				outcome: "dispatch_failed",
				summary: "dispatch failed",
			}).catch((error) =>
				console.error("Failed to release run claim:", error),
			);
			return c.json({ error: "dispatch failed" }, 502);
		}

		return c.json({ dispatched: "spec-to-pr", runId }, 202);
	});

	return app;
}
