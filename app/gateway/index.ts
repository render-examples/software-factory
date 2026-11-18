import { Hono } from "hono";
import type { TaskName } from "../config/index.js";
import { append, type Db } from "../db/index.js";
import { errorMessage } from "../util/index.js";
import { readBody } from "./body.js";
import { type Decision, deliveryEvent, route } from "./routes.js";
import { verifySignature } from "./signature.js";
import { threadState } from "./state.js";
import { agentRunStream, githubThreadStream, requireReader, type StreamDeps, threadStream } from "./stream.js";

export { EventHub, listen } from "./hub.js";

export interface GatewayDeps extends StreamDeps {
	startTask(task: TaskName, input: object, idempotencyKey: string): Promise<{ id: string }>;
	webhookSecret: string;
	db: Db;
}

export function createGateway(deps: GatewayDeps): Hono {
	const app = new Hono();

	app.get("/", (c) =>
		c.text(
			"software-factory gateway is running.\n\n" +
				"It has no web UI. GitHub sends webhooks to POST /webhooks/github, and the factory replies on issues and pull requests.\n" +
				"Health checks: GET /health and GET /ready. Setup and usage: docs/quickstart.md in your software-factory repository.\n",
		),
	);
	app.get("/health", (c) => c.json({ status: "ok" }));
	app.get("/ready", (c) => c.json({ status: "ready" }));

	const reader = requireReader(deps.eventsReadToken);
	app.get("/agent-runs/:id/stream", reader, agentRunStream(deps));
	app.get("/threads/:thread/stream", reader, threadStream(deps));
	app.get("/threads/github/:owner/:repo/:kind/:number/stream", reader, githubThreadStream(deps));

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
			payload = JSON.parse(body.toString("utf8"));
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}

		const routed = route(event, payload, deliveryId);
		let decision: Decision;
		try {
			decision = routed.kind === "lookup" ? routed.decide(await threadState(deps.db, routed.thread)) : routed;
			await deps.db.withTx((tx) => append(tx, deliveryEvent(deliveryId, event, decision)));
		} catch (error) {
			warn("could not record delivery", { deliveryId, event, error: errorMessage(error) });
			return c.json({ error: "could not record delivery" }, 502);
		}
		if (decision.kind === "ignore") return c.json({ ignored: decision.reason });

		if (decision.kind === "invalid") {
			const { task, thread, reason } = decision;
			warn("authenticated delivery produced an invalid task input", { deliveryId, event, task, thread, reason });
			return c.json({ error: "invalid task input", task }, 422);
		}

		const { task, thread, idempotencyKey, input } = decision;
		try {
			const run = await deps.startTask(task, input, idempotencyKey);
			return c.json({ runId: run.id, task }, 202);
		} catch (error) {
			warn("could not start task", { deliveryId, event, task, thread, error: errorMessage(error) });
			return c.json({ error: "could not start task", task }, 502);
		}
	});

	return app;
}

function warn(msg: string, fields: Record<string, unknown>): void {
	console.error(JSON.stringify({ level: "warn", msg, ...fields }));
}
