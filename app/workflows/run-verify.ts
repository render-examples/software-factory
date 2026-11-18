import type { VerifyResult } from "../format/index.js";
import type { Sandbox } from "../sandbox/index.js";
import { errorMessage } from "../util/index.js";

const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 4096;

export interface VerifyRun extends VerifyResult {
	exitCode: number | null;
	output: string;
}

export async function runVerify(sandbox: Sandbox, commands: readonly string[]): Promise<VerifyRun[]> {
	const runs: VerifyRun[] = [];
	for (const command of commands) {
		const started = Date.now();
		try {
			const res = await sandbox.exec(command, { asRunner: true, timeoutMs: COMMAND_TIMEOUT_MS });
			const output = [res.stdout.trimEnd(), res.stderr.trimEnd()].filter(Boolean).join("\n");
			runs.push({ command, passed: res.exitCode === 0, exitCode: res.exitCode, output: tail(output), durationMs: Date.now() - started });
		} catch (err) {
			const message = errorMessage(err);
			runs.push({ command, passed: false, exitCode: null, output: tail(`The command did not finish: ${message}`), durationMs: Date.now() - started });
		}
	}
	return runs;
}

const tail = (text: string): string => (text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text);
