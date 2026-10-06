import { Hono } from "hono";
import { ping } from "../store/index.js";
import { apiRoutes } from "./api.js";
import { publicArtifactRoutes, uiArtifactRoutes } from "./artifacts.js";
import { uiRoutes } from "./ui/index.js";
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
	app.route("/api", apiRoutes());
	app.route("/", publicArtifactRoutes());
	app.route("/", uiArtifactRoutes());
	app.route("/", uiRoutes());
	return app;
}
