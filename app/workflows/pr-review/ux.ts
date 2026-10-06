import type { TaskContext } from "@renderinc/sdk/workflows";
import { uxTestOutputSchema, type UxTestOutput } from "../../contracts/ux.js";
import { uxTester } from "../../agents/reviewers/ux-tester.js";
import { agentTask } from "../../tasks/index.js";
import { parseModelJson } from "../../runners/index.js";

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
	const task = agentTask(uxTester);

	const message = [
		`## Base URL\n\n${opts.baseUrl}`,
		`## Acceptance criteria\n\n${opts.criteria}`,
		"Navigate to the base URL and test each criterion.",
	].join("\n\n");

	const raw = await ctx.run(task, {
		runId: opts.runId,
		message,
		sandboxId: opts.sandboxId,
		browser: { origins: [origin] },
	});

	const parsed = parseModelJson(uxTestOutputSchema, raw);
	return parsed ?? { results: [] };
}
