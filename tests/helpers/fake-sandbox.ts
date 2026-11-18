import { asciiJson } from "../../app/runner/core/emit.js";
import type { RunnerEvent } from "../../app/runner/core/protocol.js";
import type { ExecOptions, ExecResult, ExecStreamOptions, OpenedSandbox, Sandbox, SandboxRef, SnapshotManifest } from "../../app/sandbox/types.js";

type WithoutAt<E> = E extends unknown ? Omit<E, "at"> : never;

/** One JSONL line as the runner would write it. */
export const eventLine = (event: WithoutAt<RunnerEvent>): string => asciiJson(JSON.stringify({ at: new Date().toISOString(), ...event }));

export interface FakeSandboxOptions {
	/** The runner's stdout, served as `<runDir>.jsonl`; null makes the download fail. */
	jsonl: string | null;
	/** run-agent.sh's stdout as the host receives it, chunk by chunk; an Error drops the stream. Default: `jsonl` in one chunk. */
	live?: (string | Error)[];
}

/**
 * Records every call; serves a canned `.jsonl` for whatever run directory `runAgent` creates, live while
 * run-agent.sh runs, and from a byte offset to the follow command's `tail -c +<offset+1> -f`.
 */
export class FakeSandbox implements Sandbox {
	readonly id = "sbx-fake";
	readonly execs: Array<{ command: string; opts?: ExecOptions | ExecStreamOptions }> = [];
	readonly uploads = new Map<string, string>();
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
				opts.onData("stdout", step);
			}
			return 0;
		}
		const follow = /tail -c \+(\d+) -f /.exec(command);
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
		if (path === `${this.runDir}.jsonl` && this.options.jsonl !== null) return Buffer.from(this.options.jsonl);
		throw new Error(`no such file: ${path}`);
	}

	async close(): Promise<void> {}
}

type Answer = ExecResult | Error;

export const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

/**
 * A sandbox a workflow opened. Answers each command from the first `results` key it starts with: a list answers in
 * turn and repeats its last entry; anything else gets "ok".
 */
export class FakeOpenedSandbox implements OpenedSandbox {
	readonly id: string;
	readonly headSha: string;
	readonly manifest: SnapshotManifest;
	readonly execs: Array<{ command: string; opts?: ExecOptions }> = [];
	readonly opened: Array<SandboxRef & { repo: string }> = [];
	closed = 0;
	results: Record<string, Answer | Answer[]>;

	constructor(opts: { id?: string; headSha?: string; results?: Record<string, Answer | Answer[]> } = {}) {
		this.id = opts.id ?? "sbx-1";
		this.headSha = opts.headSha ?? "b".repeat(40);
		this.manifest = { repo: "", baseBranch: "main", sha: this.headSha, lockfileHash: "", install: null, createdAt: "" };
		this.results = opts.results ?? {};
	}

	/** An `openSandbox` dependency that records the repository and ref it opens. */
	open = async (repo: { fullName: string }, ref: SandboxRef): Promise<OpenedSandbox> => {
		this.opened.push({ repo: repo.fullName, ...ref });
		return this;
	};

	async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
		this.execs.push({ command, opts });
		const key = Object.keys(this.results).find((prefix) => command.startsWith(prefix));
		let answer = key === undefined ? undefined : this.results[key];
		if (Array.isArray(answer)) answer = answer.length > 1 ? answer.shift() : answer[0];
		if (answer instanceof Error) throw answer;
		return answer ?? ok("ok\n");
	}

	async execStream(): Promise<number> {
		throw new Error("not used");
	}

	async upload(): Promise<void> {}

	async download(): Promise<Buffer> {
		throw new Error("not used");
	}

	async close(): Promise<void> {
		this.closed++;
	}
}
