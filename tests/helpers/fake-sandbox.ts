import type { RunnerEvent } from "../../app/runner/core/protocol.js";
import type { ExecOptions, ExecResult, Sandbox } from "../../app/sandbox/types.js";

type WithoutAt<E> = E extends unknown ? Omit<E, "at"> : never;

/** One JSONL line as the runner would write it. */
export const eventLine = (event: WithoutAt<RunnerEvent>): string => JSON.stringify({ at: new Date().toISOString(), ...event });

export interface FakeSandboxOptions {
	/** The runner's stdout, served as `<runDir>.jsonl`; null makes the download fail. */
	jsonl: string | null;
	/** Exit code of run-agent.sh. */
	runExitCode?: number;
}

/** Records every call; serves a canned `.jsonl` for whatever run directory `runAgent` creates. */
export class FakeSandbox implements Sandbox {
	readonly id = "sbx-fake";
	readonly execs: Array<{ command: string; opts?: ExecOptions }> = [];
	readonly uploads = new Map<string, string>();
	readonly downloads: string[] = [];
	runDir: string | undefined;

	constructor(private readonly options: FakeSandboxOptions) {}

	async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
		this.execs.push({ command, opts });
		const mkdir = /^mkdir -m 700 (\S+)$/.exec(command);
		if (mkdir) this.runDir = mkdir[1];
		if (command.includes("run-agent.sh")) return { exitCode: this.options.runExitCode ?? 0, stdout: "", stderr: "" };
		return { exitCode: 0, stdout: "", stderr: "" };
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
