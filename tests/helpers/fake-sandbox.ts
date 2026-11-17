import type { RunnerEvent } from "../../app/runner/core/protocol.js";
import type { ExecOptions, ExecResult, ExecStreamOptions, Sandbox } from "../../app/sandbox/types.js";

type WithoutAt<E> = E extends unknown ? Omit<E, "at"> : never;

/** One JSONL line as the runner would write it. */
export const eventLine = (event: WithoutAt<RunnerEvent>): string => JSON.stringify({ at: new Date().toISOString(), ...event });

/** A step of run-agent.sh's live stdout: a chunk, a pause until the promise settles, or the stream dropping. */
export type LiveStep = string | Promise<unknown> | Error;

export interface FakeSandboxOptions {
	/** The runner's stdout, served as `<runDir>.jsonl`; null makes the download fail. */
	jsonl: string | null;
	/** run-agent.sh's stdout as the host receives it. Default: `jsonl` in one chunk. */
	live?: LiveStep[];
	/** Exit code of run-agent.sh. */
	runExitCode?: number;
}

/**
 * Records every call; serves a canned `.jsonl` for whatever run directory `runAgent` creates, live while
 * run-agent.sh runs, and from a byte offset to `tail -c +<offset+1> -f`.
 */
export class FakeSandbox implements Sandbox {
	readonly id = "sbx-fake";
	readonly execs: Array<{ command: string; opts?: ExecOptions | ExecStreamOptions }> = [];
	readonly uploads = new Map<string, string>();
	readonly downloads: string[] = [];
	runDir: string | undefined;

	constructor(private readonly options: FakeSandboxOptions) {}

	async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
		this.execs.push({ command, opts });
		const mkdir = /^mkdir -m 700 (\S+)$/.exec(command);
		if (mkdir) this.runDir = mkdir[1];
		return { exitCode: 0, stdout: "", stderr: "" };
	}

	async execStream(command: string, opts: ExecStreamOptions): Promise<number> {
		this.execs.push({ command, opts });
		if (command.includes("run-agent.sh")) {
			for (const step of this.options.live ?? [this.options.jsonl ?? ""]) {
				if (step instanceof Error) throw step;
				if (typeof step === "string") opts.onData("stdout", step);
				else await step;
			}
			return this.options.runExitCode ?? 0;
		}
		const follow = /^tail -c \+(\d+) -f /.exec(command);
		if (!follow || this.options.jsonl === null) return 1;
		opts.onData(
			"stdout",
			Buffer.from(this.options.jsonl)
				.subarray(Number(follow[1]) - 1)
				.toString("utf8"),
		);
		return 0;
	}

	async upload(path: string, data: string | Buffer): Promise<void> {
		this.uploads.set(path, data.toString());
	}

	async download(path: string): Promise<Buffer> {
		this.downloads.push(path);
		if (path === `${this.runDir}.jsonl` && this.options.jsonl !== null) return Buffer.from(this.options.jsonl);
		throw new Error(`no such file: ${path}`);
	}

	async close(): Promise<void> {}
}
