import { prReviewer, type RunAgentOptions, type runAgent } from "../../agents/index.js";
import type { Review } from "../../schemas/index.js";

export type RunAgent = typeof runAgent;

/** Runs the reviewer in the PR sandbox. */
export async function reviewPull(run: RunAgent, message: string, opts: RunAgentOptions): Promise<Review> {
	return (await run(prReviewer, message, opts)).output;
}
