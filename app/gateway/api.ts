import { Hono } from "hono";
import { z } from "zod";
import {
	getRun,
	getSpec,
	listArtifactsByRun,
	listConversation,
	listDeliveries,
	listRuns,
	listSpecVersions,
} from "../store/index.js";
import { listEventsByRun } from "../store/queries.js";
import { constantTimeEqual } from "./auth.js";

const listRunsQuery = z.object({
	workflow: z.string().optional(),
	status: z
		.enum([
			"queued",
			"dispatched",
			"running",
			"completed",
			"failed",
			"cancelled",
		])
		.optional(),
	subjectKind: z.enum(["issue", "pull_request"]).optional(),
	subjectNumber: z.coerce.number().int().positive().optional(),
	before: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function apiRoutes(): Hono {
	const app = new Hono();

	app.use("*", async (c, next) => {
		const adminToken = process.env.FACTORY_ADMIN_TOKEN?.trim();
		if (!adminToken) return c.json({ error: "not configured" }, 500);

		const auth = c.req.header("authorization") ?? "";
		const prefix = "Bearer ";
		if (!auth.startsWith(prefix)) {
			return c.json({ error: "unauthorized" }, 401);
		}
		const token = auth.slice(prefix.length);
		if (!constantTimeEqual(token, adminToken)) {
			return c.json({ error: "unauthorized" }, 401);
		}
		await next();
	});

	app.get("/runs", async (c) => {
		const parsed = listRunsQuery.safeParse(c.req.query());
		if (!parsed.success) {
			return c.json(
				{ error: "invalid query", details: parsed.error.issues },
				400,
			);
		}
		const runs = await listRuns(parsed.data);
		return c.json({ runs });
	});

	app.get("/runs/:id", async (c) => {
		const id = c.req.param("id");
		const run = await getRun(id);
		if (!run) return c.json({ error: "not found" }, 404);
		const conversation = await listConversation(id);
		return c.json({ run, conversation });
	});

	app.get("/runs/:id/events", async (c) => {
		const id = c.req.param("id");
		const run = await getRun(id);
		if (!run) return c.json({ error: "not found" }, 404);
		const events = await listEventsByRun(id);
		return c.json({ events });
	});

	app.get("/runs/:id/artifacts", async (c) => {
		const id = c.req.param("id");
		const run = await getRun(id);
		if (!run) return c.json({ error: "not found" }, 404);
		const artifacts = await listArtifactsByRun(id);
		return c.json({ artifacts });
	});

	app.get("/specs/:id", async (c) => {
		const id = c.req.param("id");
		const spec = await getSpec(id);
		if (!spec) return c.json({ error: "not found" }, 404);
		const versions = await listSpecVersions(id);
		return c.json({ spec, versions });
	});

	app.get("/deliveries", async (c) => {
		const limit = Math.min(
			Math.max(Number(c.req.query("limit") ?? 50), 1),
			200,
		);
		const deliveries = await listDeliveries(limit);
		return c.json({ deliveries });
	});

	return app;
}
