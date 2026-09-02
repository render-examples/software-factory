import { factoryConfig } from "../../../factory.config.js";
import { implementationSchema } from "../../contracts/index.js";
import { type Checkout, commitChanges, runVerification } from "../../git/index.js";
import type { Sandbox } from "../../sandbox/index.js";
import { implementTask } from "../../tasks/index.js";
import { agentJson } from "../agent-json.js";
import { MAX_VERIFY_ROUNDS } from "./constants.js";

/** What the implementer produced, and the commit it produced it in. */
export interface ImplementationState {
	summary: string;
	sha: string;
}

export interface ImplementOptions {
	sandbox: Sandbox;
	checkout: Checkout;
	/** The full instruction sent to the implementer. */
	prompt: string;
	/** HEAD before this round, used to detect that nothing changed. */
	previousSha: string;
	commitMessage: string;
	/** Names this round in logs when JSON repair is needed. */
	stage: string;
}

/**
 * Ask the implementer for a change and commit whatever it wrote.
 *
 * `sha` is null when the agent left the tree untouched, which the caller
 * interprets differently depending on the round.
 */
export async function implementAndCommit(
	opts: ImplementOptions,
): Promise<{ summary: string; sha: string | null }> {
	const { summary } = await agentJson(
		(message) => implementTask({ message, sandboxId: opts.sandbox.id }),
		implementationSchema,
		opts.prompt,
		opts.stage,
	);
	const sha = await commitChanges(
		opts.sandbox,
		opts.checkout,
		opts.previousSha,
		opts.commitMessage,
	);
	return { summary, sha };
}

export type VerificationOutcome =
	| { passed: true; state: ImplementationState }
	| { passed: false; failures: string };

/**
 * Run the configured verify commands, feeding failures back to the implementer
 * until they pass or the round limit is reached.
 *
 * The workflow runs the commands, not the agent, so a passing build cannot be
 * asserted by a model that never ran one.
 */
export async function verifyWithFixes(opts: {
	sandbox: Sandbox;
	checkout: Checkout;
	issueNumber: number;
	workItem: string;
	state: ImplementationState;
}): Promise<VerificationOutcome> {
	let state = opts.state;
	if (factoryConfig.verify.length === 0) return { passed: true, state };

	for (let round = 0; round <= MAX_VERIFY_ROUNDS; round++) {
		const verification = await runVerification(
			opts.sandbox,
			factoryConfig.verify,
		);
		if (verification.passed) return { passed: true, state };
		if (round === MAX_VERIFY_ROUNDS) {
			return { passed: false, failures: verification.failures };
		}

		const fix = await implementAndCommit({
			sandbox: opts.sandbox,
			checkout: opts.checkout,
			previousSha: state.sha,
			stage: `verify-fix-${round}`,
			commitMessage: `Fix verification failures for issue #${opts.issueNumber}`,
			prompt:
				"The following verification commands failed. Fix the issues so all commands pass.\n\n" +
				`Work item:\n${opts.workItem}\n\nFailures:\n${verification.failures}`,
		});
		state = { summary: fix.summary, sha: fix.sha ?? state.sha };
	}

	return { passed: true, state };
}
