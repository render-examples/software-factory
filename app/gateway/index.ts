import { Hono } from "hono";
import type { ZodType } from "zod";
import { TASKS, type TaskName } from "../config/index.js";
import {
	CancelInput,
	PrReviewInput,
	RefreshSnapshotInput,
	SpecToPrInput,
	TriageInput,
} from "../contracts/tasks.js";
import { emit as defaultEmit, listTraces, recentEvents, traceEvents } from "../events/index.js";
import { readBody } from "./body.js";
import { route } from "./routes.js";
import { verifySignature } from "./signature.js";
import { type EventsReader, uiRoutes } from "./ui/index.js";

export type { Route } from "./routes.js";
export type { EventsReader } from "./ui/index.js";

export interface GatewayDeps {
	startTask(task: TaskName, input: object, idempotencyKey: string): Promise<{ id: string }>;
	emit?: typeof defaultEmit;
	webhookSecret: string;
	/** FACTORY_ADMIN_TOKEN. Without it /ui and /api answer 503. */
	adminToken?: string;
	/** What the trace UI reads; defaults to Postgres. */
	events?: EventsReader;
}

const INPUTS: Record<TaskName, ZodType> = {
	[TASKS.triage]: TriageInput,
	[TASKS.specToPr]: SpecToPrInput,
	[TASKS.prReview]: PrReviewInput,
	[TASKS.cancel]: CancelInput,
	[TASKS.refreshSnapshot]: RefreshSnapshotInput,
};

export function createGateway(deps: GatewayDeps): Hono {
	const emit = deps.emit ?? defaultEmit;
	const app = new Hono();

	app.get("/health", (c) => c.json({ status: "ok" }));
	// Gateway readiness does not touch Postgres; phase tasks perform the strict coordination check.
	app.get("/ready", (c) => c.json({ status: "ready" }));

	app.post("/webhooks/github", async (c) => {
		const event = c.req.header("x-github-event") ?? "";
		const deliveryId = c.req.header("x-github-delivery") ?? "";
		const delivered = (fields: {
			outcome: string;
			reason?: string;
			action?: string;
			repo?: string;
			subject?: string;
			runId?: string;
			task?: string;
		}) => {
			const { repo, subject, runId, ...rest } = fields;
			// Not awaited: a slow or absent database must not delay the response to GitHub.
			void emit({
				traceId: runId ?? (deliveryId || crypto.randomUUID()),
				runId,
				repo,
				subject,
				type: "delivery.received",
				payload: { event, deliveryId: deliveryId || null, ...rest },
			});
		};

		// Unauthenticated requests are answered without an event, so they can't write to the database.
		const body = await readBody(c.req.raw);
		if (body === null) return c.json({ error: "payload too large" }, 413);
		if (!verifySignature(body, c.req.header("x-hub-signature-256"), deps.webhookSecret)) {
			return c.json({ error: "invalid signature" }, 401);
		}
		if (!deliveryId) {
			delivered({ outcome: "rejected", reason: "missing delivery id" });
			return c.json({ error: "missing x-github-delivery" }, 400);
		}

		let payload: unknown;
		try {
			payload = JSON.parse(body);
		} catch {
			delivered({ outcome: "rejected", reason: "invalid json" });
			return c.json({ error: "invalid json" }, 400);
		}

		const action = stringAt(payload, "action");
		const repo = stringAt(payload, "repository", "full_name");
		const decision = route(event, payload, deliveryId);
		if (decision.kind === "ignore") {
			delivered({ outcome: "ignored", reason: decision.reason, action, repo });
			return c.json({ ignored: decision.reason });
		}

		const { task, subject, idempotencyKey } = decision;
		const parsed = INPUTS[task].safeParse(decision.input);
		if (!parsed.success) {
			delivered({ outcome: "invalid", reason: parsed.error.message, action, repo, subject, task });
			return c.json({ error: "invalid task input", task }, 422);
		}

		try {
			const run = await deps.startTask(task, parsed.data as object, idempotencyKey);
			delivered({ outcome: "started", action, repo, subject, task, runId: run.id });
			return c.json({ runId: run.id, task }, 202);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			delivered({ outcome: "start failed", reason, action, repo, subject, task });
			// A 5xx marks the delivery failed in GitHub, where it can be redelivered by hand.
			return c.json({ error: "could not start task", task }, 502);
		}
	});

	app.route(
		"/",
		uiRoutes({
			adminToken: deps.adminToken?.trim() || undefined,
			events: deps.events ?? { listTraces, traceEvents, recentEvents },
		}),
	);

	return app;
}

function stringAt(value: unknown, ...path: string[]): string | undefined {
	let current = value;
	for (const key of path) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" ? current : undefined;
}
