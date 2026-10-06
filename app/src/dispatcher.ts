import { Render } from "@renderinc/sdk";
import { assertDispatcherEnv, requireEnv } from "../config/index.js";
import { startDispatchLoop } from "../dispatcher/index.js";

assertDispatcherEnv();

const workflowSlug = requireEnv("RENDER_WORKFLOW_SLUG");
const render = new Render();

const loop = startDispatchLoop({
	workflowSlug,
	startTask: (taskPath, args) => render.workflows.startTask(taskPath, args),
});

console.log("dispatcher: polling for queued runs");

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		if (stopping) return;
		stopping = true;
		console.log(`dispatcher: received ${signal}, finishing current batch`);
		loop.stop();
		setTimeout(() => process.exit(0), 5_000);
	});
}
