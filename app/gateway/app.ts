import { Hono } from "hono";
import { ping } from "../store/index.js";
import { githubWebhook } from "./webhook.js";

/**
 * The gateway runs no models and holds no GitHub token. It validates webhooks
 * and dispatches; everything else happens in the workflows process.
 */
export function createGateway(): Hono {
	const app = new Hono();

	// Liveness. Deliberately does not touch Postgres.
	app.get("/health", (c) => c.json({ status: "ok" }));

	// Readiness, and Render's health-check target.
	app.get("/ready", async (c) => {
		try {
			await ping();
			return c.json({ status: "ready" });
		} catch {
			return c.json({ status: "unavailable" }, 503);
		}
	});

	app.route("/", githubWebhook());
	return app;
}
