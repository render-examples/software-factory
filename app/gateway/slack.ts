/** Signed Slack intake for the bounded assistant workflow. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
	abandonSlackDelivery,
	claimSlackDelivery,
	markSlackDispatched,
} from "../lib/slack-state.js";
import { readRequestBody } from "./body.js";
import { dispatchWorkflowTask } from "./dispatch.js";

const envelopeSchema = z.object({
	type: z.string(),
	challenge: z.string().optional(),
	event_id: z.string().optional(),
	event: z
		.object({
			type: z.string(),
			channel: z.string().optional(),
			channel_type: z.string().optional(),
			user: z.string().optional(),
			text: z.string().optional(),
			ts: z.string().optional(),
			thread_ts: z.string().optional(),
			bot_id: z.string().optional(),
			subtype: z.string().optional(),
		})
		.optional(),
});

export function slackConfigured(): boolean {
	return Boolean(process.env.SLACK_SIGNING_SECRET);
}

function verifySlackSignature(rawBody: string, headers: Headers): boolean {
	const secret = process.env.SLACK_SIGNING_SECRET;
	const timestamp = headers.get("x-slack-request-timestamp");
	const signature = headers.get("x-slack-signature");
	if (!secret || !timestamp || !signature) return false;
	const seconds = Number(timestamp);
	if (
		!Number.isFinite(seconds) ||
		!Number.isInteger(seconds) ||
		Math.abs(Date.now() / 1000 - seconds) > 300
	) {
		return false;
	}
	const computed = `v0=${createHmac("sha256", secret)
		.update(`v0:${timestamp}:${rawBody}`)
		.digest("hex")}`;
	try {
		return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
	} catch {
		return false;
	}
}

export function slackHandler(): Hono {
	const app = new Hono();

	app.post("/slack", async (c) => {
		const rawBody = await readRequestBody(c.req.raw);
		if (rawBody === null) {
			return c.json({ error: "payload too large" }, 413);
		}
		if (!verifySlackSignature(rawBody, c.req.raw.headers)) {
			return c.json({ error: "invalid signature" }, 401);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody);
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const result = envelopeSchema.safeParse(parsed);
		if (!result.success) return c.json({ error: "invalid payload" }, 400);
		const body = result.data;

		if (body.type === "url_verification" && body.challenge) {
			return c.json({ challenge: body.challenge });
		}

		const event = body.event;
		if (
			body.type !== "event_callback" ||
			!body.event_id ||
			!event?.channel ||
			!event.user ||
			!event.ts ||
			event.bot_id ||
			event.subtype
		) {
			return c.json({ ok: true, skipped: true });
		}

		const isDirectMessage =
			event.channel_type === "im" || event.channel.startsWith("D");
		const supported =
			event.type === "app_mention" ||
			(event.type === "message" &&
				(isDirectMessage || typeof event.thread_ts === "string"));
		if (!supported) return c.json({ ok: true, skipped: true });

		let claim: Awaited<ReturnType<typeof claimSlackDelivery>>;
		try {
			claim = await claimSlackDelivery(body.event_id);
		} catch (error) {
			console.error("Failed to claim Slack delivery:", error);
			return c.json({ error: "assistant state unavailable" }, 503);
		}
		if (claim === "dispatched") {
			return c.json({ ok: true, skipped: true });
		}

		const threadTs = event.thread_ts ?? event.ts;
		const threadId = isDirectMessage
			? event.channel
			: `${event.channel}:${threadTs}`;
		const text = (event.text ?? "").replace(/^\s*<@[^>]+>\s*/, "");
		const dispatch = await dispatchWorkflowTask("slack-assistant", {
			eventId: body.event_id,
			message: text,
			threadId,
			slackChannel: event.channel,
			slackThreadTs: threadTs,
			slackUserId: event.user,
		});
		if (!dispatch.ok) {
			if (claim === "claimed") {
				await abandonSlackDelivery(body.event_id).catch(() => {});
			}
			return c.json({ error: "assistant dispatch failed" }, 503);
		}

		try {
			await markSlackDispatched(body.event_id);
		} catch (error) {
			console.error("Failed to mark Slack delivery dispatched:", error);
			return c.json({ error: "assistant state unavailable" }, 503);
		}
		return c.json({ ok: true });
	});

	return app;
}
