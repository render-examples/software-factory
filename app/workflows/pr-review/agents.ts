import { AgentError, prReviewer, type RunAgentOptions, type runAgent } from "../../agents/index.js";
import type { Review } from "../../schemas/index.js";
import type { Sandbox } from "../../sandbox/index.js";

export type RunAgent = typeof runAgent;

/** Runs the reviewer in the PR sandbox. */
export async function reviewPull(
	run: RunAgent,
	opts: {
		sandbox: Sandbox;
		message: string;
		base: Omit<RunAgentOptions, "sandbox">;
	},
): Promise<Review> {
	const res = await run(prReviewer, opts.message, { ...opts.base, sandbox: opts.sandbox });
	return res.output;
}

/** Why an agent failed, safe to post: its error code. The message (which can quote sandbox output) stays in the logs. */
export function failureReason(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	console.error(
		JSON.stringify({
			level: "warn",
			msg: "agent failed",
			code: err instanceof AgentError ? err.code : undefined,
			error: message.slice(0, 1000),
		}),
	);
	return err instanceof AgentError ? `stopped with \`${err.code}\`` : "failed unexpectedly";
}
