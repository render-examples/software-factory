import type { VerifyResult } from "../../format/index.js";
import type { Sandbox } from "../../sandbox/index.js";

/** A verify command as PR Reviewer ran it, with what the agents need to judge a failure. */
export interface VerifyRun extends VerifyResult {
	exitCode: number | null;
	/** The end of stdout and stderr, for the agents' messages. Never posted to GitHub. */
	outputTail: string;
}

const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const TAIL_CHARS = 3_000;

/** Runs each verify command as the runner user in the checkout. A failure is recorded, never thrown. */
export async function runVerify(sandbox: Sandbox, commands: readonly string[]): Promise<VerifyRun[]> {
	const runs: VerifyRun[] = [];
	for (const command of commands) {
		const started = Date.now();
		try {
			const res = await sandbox.exec(command, {
				asRunner: true,
				timeoutMs: COMMAND_TIMEOUT_MS,
			});
			const output = [res.stdout, res.stderr].filter((s) => s.trim()).join("\n");
			runs.push({
				command,
				passed: res.exitCode === 0,
				exitCode: res.exitCode,
				durationMs: Date.now() - started,
				outputTail: tail(output),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			runs.push({
				command,
				passed: false,
				exitCode: null,
				durationMs: Date.now() - started,
				outputTail: `could not run: ${tail(message)}`,
			});
		}
	}
	return runs;
}

const tail = (s: string) => (s.length > TAIL_CHARS ? `…${s.slice(-TAIL_CHARS)}` : s);
