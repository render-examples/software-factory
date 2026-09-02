import type { Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";
import { REPO_DIR } from "./run.js";
import type { VerificationResult } from "./types.js";

const MAX_VERIFY_OUTPUT_CHARS = 10_000;

/** Run factoryConfig.verify commands and summarize failures. */
export async function runVerification(
	sandbox: Sandbox,
	commands: readonly string[],
): Promise<VerificationResult> {
	const failures: string[] = [];

	for (const command of commands) {
		const { output, exitCode } = await sandbox.run(
			`cd ${shellEscape(REPO_DIR)} && ${command}`,
		);
		if (exitCode !== 0) {
			failures.push(
				`Command: ${command}\nExit code: ${exitCode}\nOutput:\n${output.slice(0, MAX_VERIFY_OUTPUT_CHARS)}`,
			);
		}
	}

	return {
		passed: failures.length === 0,
		failures: failures.join("\n\n---\n\n"),
	};
}
