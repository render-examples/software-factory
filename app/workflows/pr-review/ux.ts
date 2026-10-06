import type { TaskContext } from "@renderinc/sdk/workflows";
import {
	uxTestOutputSchema,
	type UxTestOutput,
} from "../../contracts/index.js";
import { uxTesterTask } from "../../tasks/index.js";
import { agentJson } from "../agent-json.js";

/**
 * Run the UX tester agent against a base URL.
 * The agent gets browser tools restricted to the specified origins.
 */
export async function runUxTests(
	ctx: TaskContext,
	opts: {
		runId: string;
		sandboxId: string;
		baseUrl: string;
		criteria: string;
	},
): Promise<UxTestOutput> {
	const origin = new URL(opts.baseUrl).origin;

	const message = [
		`## Base URL\n\n${opts.baseUrl}`,
		`## Acceptance criteria\n\n${opts.criteria}`,
		"Navigate to the base URL and test each criterion.",
	].join("\n\n");

	return agentJson(
		(input) =>
			ctx.run(uxTesterTask, {
				runId: opts.runId,
				message: input,
				sandboxId: opts.sandboxId,
				browser: { origins: [origin] },
			}),
		uxTestOutputSchema,
		message,
		"ux-tester",
	);
}
