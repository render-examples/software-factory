import type { Sandbox } from "../sandbox/index.js";
import { shellEscape } from "../shell/index.js";
import { REPO_DIR } from "./run.js";
import type { CommandResult, VerificationResult } from "./types.js";

const MAX_VERIFY_OUTPUT_CHARS = 10_000;
const OUTPUT_TAIL_CHARS = 2_000;

/** Run the configured verify commands, keeping per-command evidence. */
export async function runVerification(
	sandbox: Sandbox,
	commands: readonly string[],
): Promise<VerificationResult> {
	const results: CommandResult[] = [];
	const failures: string[] = [];

	for (const command of commands) {
		const started = Date.now();
		const { output, exitCode } = await sandbox.run(
			`cd ${shellEscape(REPO_DIR)} && ${command}`,
		);
		results.push({
			command,
			exitCode,
			durationMs: Date.now() - started,
			outputTail: output.slice(-OUTPUT_TAIL_CHARS),
		});
		if (exitCode !== 0) {
			failures.push(
				`Command: ${command}\nExit code: ${exitCode}\nOutput:\n${output.slice(0, MAX_VERIFY_OUTPUT_CHARS)}`,
			);
		}
	}

	return {
		passed: failures.length === 0,
		failures: failures.join("\n\n---\n\n"),
		results,
	};
}
