import { config, TASKS } from "../config/index.js";
import { CancelInput } from "../schemas/index.js";
import { defineGitHubTask } from "./github-task.js";

const codes = (ids: readonly string[]) => ids.map((id) => `\`${id}\``).join(", ");

export const cancelWorkflow = defineGitHubTask(
	{ name: TASKS.cancel, title: "Cancel", input: CancelInput, thread: (input) => ({ kind: input.kind, number: input.number }), timeoutSeconds: 120 },
	async ({ displaced, cleanup }) => {
		if (cleanup.unconfirmed.length) {
			const tookOver = displaced ? `stopped \`${displaced.traceId}\` from working here, but ` : "";
			const retry = `Comment \`${config.commandPrefix} cancel\` to try again.`;
			const summary = `${tookOver}Render hasn't confirmed that ${codes(cleanup.unconfirmed)} stopped. ${retry}`;
			return { outcome: "cancel_unconfirmed", state: "failed", summary };
		}
		if (displaced) {
			const child = displaced.runIds.find((runId) => runId !== displaced.traceId);
			return { outcome: "cancelled", summary: `cancelled \`${displaced.traceId}\`${child ? ` and its current run \`${child}\`` : ""}.` };
		}
		if (cleanup.confirmed.length) return { outcome: "cleaned_up", summary: `finished stopping ${codes(cleanup.confirmed)}.` };
		return { outcome: "nothing_running", summary: "nothing was running." };
	},
);

export const runCancel = cancelWorkflow.run;
