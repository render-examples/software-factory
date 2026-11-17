import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "../runner/core/emit.js";
import { shq } from "../sandbox/shell.js";
import type { ExecStreamOptions, Sandbox } from "../sandbox/types.js";

const RETRY_MS = 5_000;

/**
 * Splits output arriving in chunks into lines and passes on each complete line once. `offset` counts the bytes of
 * the lines passed on, so output read again from `offset` after `restart` neither skips nor repeats a line.
 */
export class LineRelay {
	#offset = 0;
	#partial = "";

	constructor(private readonly onLine: (line: string) => void) {}

	get offset(): number {
		return this.#offset;
	}

	push(data: string): void {
		const lines = (this.#partial + data).split("\n");
		this.#partial = lines.pop() ?? "";
		for (const line of lines) {
			this.#offset += Buffer.byteLength(line) + 1;
			this.onLine(line);
		}
	}

	/** Drops the partial line, which output read again from `offset` repeats. */
	restart(): void {
		this.#partial = "";
	}

	/** Passes on the complete lines of `file`, the whole output, that come after `offset`. */
	finish(file: Buffer): void {
		this.restart();
		this.push(file.subarray(this.#offset).toString("utf8"));
	}
}

/**
 * Follows `<runDir>.jsonl` from `relay.offset` until run-agent.sh exits, for when its command stream dropped: the
 * command keeps running in the Sandbox. A dropped follow is retried every 5 seconds until `deadline`. Returns why
 * it stopped early, if it did.
 */
export async function followRun(
	sandbox: Sandbox,
	runDir: string,
	relay: LineRelay,
	deadline: number,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const onData: ExecStreamOptions["onData"] = (stream, data) => {
		if (stream === "stdout") relay.push(data);
	};
	let lastError = "";
	for (let attempt = 0; ; attempt++) {
		if (attempt > 0) await sleep(RETRY_MS, undefined, { signal });
		const timeoutMs = deadline - Date.now();
		if (timeoutMs <= 0) return `run-agent.sh did not finish by the deadline${lastError && ` (${lastError})`}`;
		relay.restart();
		try {
			const exitCode = await sandbox.execStream(followCommand(runDir, relay.offset), { onData, timeoutMs, signal });
			return exitCode === 0 ? undefined : `following ${runDir}.jsonl exited ${exitCode}`;
		} catch (err) {
			if (signal?.aborted) throw err;
			lastError = errorMessage(err);
		}
	}
}

/** `--pid` ends the follow once run-agent.sh exits, or at once if it already has, after reading to the end. */
const followCommand = (runDir: string, offset: number) =>
	`tail -c +${offset + 1} -f --pid="$(cat ${shq(`${runDir}.pid`)})" ${shq(`${runDir}.jsonl`)}`;
