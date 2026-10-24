import { serve } from "@hono/node-server";
import { Render } from "@renderinc/sdk";
import { requireEnv } from "../config/index.js";
import { closeEvents, listRuns, listTraceEvents } from "../events/index.js";
import { createGateway, MIN_VIEWER_PASSWORD_CHARS } from "../gateway/index.js";

const port = Number(process.env.PORT ?? 3000);
const webhookSecret = requireEnv("GITHUB_WEBHOOK_SECRET");
const workflowSlug = requireEnv("RENDER_WORKFLOW_SLUG");
// Reads RENDER_API_KEY and throws without it.
const render = new Render();

const viewerPassword = process.env.FACTORY_VIEWER_PASSWORD?.trim() ?? "";
if (viewerPassword && viewerPassword.length < MIN_VIEWER_PASSWORD_CHARS) {
	console.warn(`FACTORY_VIEWER_PASSWORD is shorter than ${MIN_VIEWER_PASSWORD_CHARS} characters, so the run viewer is off`);
}
const viewer = viewerPassword.length >= MIN_VIEWER_PASSWORD_CHARS ? { password: viewerPassword, listRuns, listTraceEvents } : undefined;

const app = createGateway({
	webhookSecret,
	viewer,
	async startTask(task, input, idempotencyKey) {
		const run = await render.workflows.startTask(`${workflowSlug}/${task}`, [input], { idempotencyKey });
		return { id: run.taskRunId };
	},
});

const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port });
console.log(`gateway listening on 0.0.0.0:${port}${viewer ? "; run viewer at /runs" : ""}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		server.close(() => {
			void closeEvents().finally(() => process.exit(0));
		});
	});
}
