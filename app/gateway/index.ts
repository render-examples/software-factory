import { Hono } from "hono";
import type { TaskName } from "../config/index.js";
import { readBody } from "./body.js";
import { route } from "./routes.js";
import { verifySignature } from "./signature.js";

export interface GatewayDeps {
	startTask(task: TaskName, input: object, idempotencyKey: string): Promise<{ id: string }>;
	webhookSecret: string;
}

/**
 * The webhook gateway. Every response says what happened to the delivery; GitHub keeps them under the App's
 * Recent Deliveries, so only failures the gateway can't explain there are logged.
 */
export function createGateway(deps: GatewayDeps): Hono {
	const app = new Hono();

	// The gateway has no UI; people who open its URL in a browser should see that it's running, not a 404.
	app.get("/", (c) =>
		c.text(
			"software-factory gateway is running.\n\n" +
				"It has no web UI. GitHub sends webhooks to POST /webhooks/github, and the factory replies on issues and pull requests.\n" +
				"Health checks: GET /health and GET /ready. Setup and usage: docs/quickstart.md in your software-factory repository.\n",
		),
	);
	app.get("/health", (c) => c.json({ status: "ok" }));
	app.get("/ready", (c) => c.json({ status: "ready" }));

	app.post("/webhooks/github", async (c) => {
		const event = c.req.header("x-github-event") ?? "";
		const deliveryId = c.req.header("x-github-delivery") ?? "";

		const body = await readBody(c.req.raw);
		if (body === null) return c.json({ error: "payload too large" }, 413);
		if (!verifySignature(body, c.req.header("x-hub-signature-256"), deps.webhookSecret)) {
			return c.json({ error: "invalid signature" }, 401);
		}
		if (!deliveryId) return c.json({ error: "missing x-github-delivery" }, 400);

		let payload: unknown;
		try {
			payload = JSON.parse(body);
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}

		const decision = route(event, payload, deliveryId);
		if (decision.kind === "ignore") return c.json({ ignored: decision.reason });

		if (decision.kind === "invalid") {
			const { task, subject, reason } = decision;
			warn("authenticated delivery produced an invalid task input", { deliveryId, event, task, subject, reason });
			return c.json({ error: "invalid task input", task }, 422);
		}

		const { task, subject, idempotencyKey, input } = decision;
		try {
			const run = await deps.startTask(task, input, idempotencyKey);
			return c.json({ runId: run.id, task }, 202);
		} catch (error) {
			warn("could not start task", { deliveryId, event, task, subject, error: error instanceof Error ? error.message : String(error) });
			// A 5xx marks the delivery failed in GitHub, where it can be redelivered by hand.
			return c.json({ error: "could not start task", task }, 502);
		}
	});

	return app;
}

function warn(msg: string, fields: Record<string, unknown>): void {
	console.error(JSON.stringify({ level: "warn", msg, ...fields }));
}
