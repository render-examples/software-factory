import { Hono } from "hono";
import { ping } from "../store/index.js";
import { githubWebhook } from "./webhook.js";

export function createGateway(): Hono {
	const app = new Hono();

	app.get("/health", (c) => c.json({ status: "ok" }));

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
