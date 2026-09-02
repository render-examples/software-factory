import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { allowedActors, repository, triggerLabel } from "../config/index.js";
import { claimRun, finishRun } from "../store/index.js";
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
		if (c.req.raw.headers.get("x-github-event") !== "issues") {
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
			return c.json({ ok: true, skipped: true });
		}

		const deliveryId = c.req.raw.headers.get("x-github-delivery");
		if (!deliveryId || !/^[A-Za-z0-9_-]{8,128}$/.test(deliveryId)) {
			return c.json({ error: "missing GitHub delivery ID" }, 400);
		}

		const runId = randomUUID();
		let claimed: boolean;
		try {
			claimed = await claimRun({
				id: runId,
				deliveryId,
				issueNumber: payload.issue.number,
			});
		} catch (error) {
			console.error("Failed to claim run:", error);
			return c.json({ error: "store unavailable" }, 503);
		}
		if (!claimed) return c.json({ ok: true, skipped: true });

		const dispatched = await dispatchWorkflow("spec-to-pr", {
			issueNumber: payload.issue.number,
			runId,
		});
		if (!dispatched) {
			await finishRun(runId, "failed", { summary: "dispatch failed" }).catch(
				(error) => console.error("Failed to release run claim:", error),
			);
			return c.json({ error: "dispatch failed" }, 502);
		}

		return c.json({ dispatched: "spec-to-pr", runId }, 202);
	});

	return app;
}
