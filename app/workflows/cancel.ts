import { TASKS } from "../config/index.js";
import { CancelInput } from "../schemas/index.js";
import { defineGitHubTask } from "./github-task.js";

export const cancelWorkflow = defineGitHubTask(
	{ name: TASKS.cancel, title: "Cancel", input: CancelInput, thread: (input) => ({ kind: input.kind, number: input.number }), timeoutSeconds: 120 },
	async (run) => {
		if (!run.displaced) return { outcome: "nothing_running", summary: "nothing was running." };
		const { traceId, runIds } = run.displaced;
		const child = runIds.find((runId) => runId !== traceId);
		return { outcome: "cancelled", summary: `cancelled \`${traceId}\`${child ? ` and its current run \`${child}\`` : ""}.` };
	},
);

export const runCancel = cancelWorkflow.run;
