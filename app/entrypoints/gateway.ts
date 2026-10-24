import { serve } from "@hono/node-server";
import { Render } from "@renderinc/sdk";
import { requireEnv } from "../config/index.js";
import { createGateway } from "../gateway/index.js";

const port = Number(process.env.PORT ?? 3000);
const webhookSecret = requireEnv("GITHUB_WEBHOOK_SECRET");
const workflowSlug = requireEnv("RENDER_WORKFLOW_SLUG");
// Reads RENDER_API_KEY and throws without it.
const render = new Render();

const app = createGateway({
	webhookSecret,
	async startTask(task, input, idempotencyKey) {
		const run = await render.workflows.startTask(`${workflowSlug}/${task}`, [input], { idempotencyKey });
		return { id: run.taskRunId };
	},
});

const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port });
console.log(`gateway listening on 0.0.0.0:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		server.close(() => process.exit(0));
	});
}
