import { setTimeout as sleep } from "node:timers/promises";
import { type ExecStreamOptions, type Sandbox, shq } from "../sandbox/index.js";
import { errorMessage } from "../util/index.js";

const RETRY_MS = 5_000;
const NOT_STARTED = 75;

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

	restart(): void {
		this.#partial = "";
	}

	finish(file: Buffer): void {
		this.restart();
		this.push(file.subarray(this.#offset).toString("utf8"));
	}
}

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
			if (exitCode === 0) return undefined;
			if (exitCode !== NOT_STARTED) return `following ${runDir}.jsonl exited ${exitCode}`;
			lastError = "run-agent.sh had not started";
		} catch (err) {
			if (signal?.aborted) throw err;
			lastError = errorMessage(err);
		}
	}
}

function followCommand(runDir: string, offset: number): string {
	const [pid, jsonl, exit] = [".pid", ".jsonl", ".exit"].map((ext) => shq(`${runDir}${ext}`));
	return (
		`if [ ! -s ${pid} ] || [ ! -f ${jsonl} ]; then [ -e ${exit} ] || exit ${NOT_STARTED}; fi; ` +
		`tail -c +${offset + 1} -f --pid="$(cat ${pid})" ${jsonl}`
	);
}
