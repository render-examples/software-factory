import type { TaskContext } from "@renderinc/sdk/workflows";
import { factoryConfig } from "../../../factory.config.js";
import { target } from "../../config/index.js";
import { implementationSchema } from "../../contracts/index.js";
import {
	type Checkout,
	commitChanges,
	runVerification,
} from "../../git/index.js";
import type { Sandbox } from "../../sandbox/index.js";
import { implementTask } from "../../tasks/index.js";
import { agentJson } from "../agent-json.js";

export interface ImplementationState {
	summary: string;
	sha: string;
}

export interface ImplementOptions {
	sandbox: Sandbox;
	checkout: Checkout;
	prompt: string;
	previousSha: string;
	commitMessage: string;
	stage: string;
}

export async function implementAndCommit(
	ctx: TaskContext,
	opts: ImplementOptions,
): Promise<{ summary: string; sha: string | null }> {
	const { summary } = await agentJson(
		(message) =>
			ctx.run(implementTask, {
				message,
				sandboxId: opts.sandbox.id,
			}),
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

/** Run verify commands, feeding failures back for up to repairRounds. */
export async function verifyWithFixes(
	ctx: TaskContext,
	opts: {
		sandbox: Sandbox;
		checkout: Checkout;
		issueNumber: number;
		workItem: string;
		state: ImplementationState;
	},
): Promise<VerificationOutcome> {
	const repo = target();
	if (repo.verify.length === 0)
		return { passed: true, state: opts.state };

	const maxRounds = factoryConfig.limits.repairRounds;
	let state = opts.state;

	for (let round = 0; round <= maxRounds; round++) {
		const verification = await runVerification(
			opts.sandbox,
			repo.verify,
		);
		if (verification.passed) return { passed: true, state };
		if (round === maxRounds) {
			return {
				passed: false,
				failures: verification.failures,
			};
		}

		const fix = await implementAndCommit(ctx, {
			sandbox: opts.sandbox,
			checkout: opts.checkout,
			previousSha: state.sha,
			stage: `verify-fix-${round}`,
			commitMessage: `Fix verification failures for issue #${opts.issueNumber}`,
			prompt:
				"The following verification commands failed. Fix the issues so all commands pass.\n\n" +
				`Work item:\n${opts.workItem}\n\nFailures:\n${verification.failures}`,
		});
		state = {
			summary: fix.summary,
			sha: fix.sha ?? state.sha,
		};
	}

	return { passed: true, state };
}
