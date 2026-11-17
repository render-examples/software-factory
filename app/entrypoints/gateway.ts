import { serve } from "@hono/node-server";
import { Render } from "@renderinc/sdk";
import { requireEnv } from "../config/index.js";
import { createDb, migrate } from "../db/index.js";
import { createGateway, EventHub, listen } from "../gateway/index.js";

const port = Number(process.env.PORT ?? 3000);
const webhookSecret = requireEnv("GITHUB_WEBHOOK_SECRET");
const eventsReadToken = requireEnv("EVENTS_READ_TOKEN");
const workflowSlug = requireEnv("RENDER_WORKFLOW_SLUG");
// Reads RENDER_API_KEY and throws without it.
const render = new Render();

const databaseUrl = requireEnv("DATABASE_URL");
const db = createDb(databaseUrl, 10);
const applied = await migrate(db);
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);

const hub = new EventHub();
const listener = listen(hub, databaseUrl);

const app = createGateway({
	webhookSecret,
	db,
	hub,
	eventsReadToken,
	async startTask(task, input, idempotencyKey) {
		const run = await render.workflows.startTask(`${workflowSlug}/${task}`, [input], { idempotencyKey });
		return { id: run.taskRunId };
	},
});

const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port });
console.log(`gateway listening on 0.0.0.0:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		server.close(() => {
			Promise.all([listener.stop(), db.end()]).finally(() => process.exit(0));
		});
	});
}
