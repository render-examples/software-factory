import { setTimeout as sleep } from "node:timers/promises";
import { ClientError, Render, ServerError } from "@renderinc/sdk";
import type { SandboxesClient, SandboxUploadContentType } from "@renderinc/sdk/experimental";
import { requireEnv } from "../config/index.js";
import { errorMessage } from "../util/index.js";
import { log } from "./shell.js";
import type { ExecResult, ExecStreamOptions } from "./types.js";

export type SandboxApi = Pick<SandboxesClient, "create" | "get" | "exec" | "upload" | "download" | "terminate"> & {
	snapshots: Pick<SandboxesClient["snapshots"], "create" | "get" | "list" | "delete">;
};

export interface SandboxTimings {
	pollMs: number;
	bootTimeoutMs: number;
	prepareTimeoutMs: number;
	snapshotTimeoutMs: number;
	verifyTimeoutMs: number;
	execTimeoutMs: number;
}

const DEFAULT_TIMINGS: SandboxTimings = {
	pollMs: 3_000,
	bootTimeoutMs: 5 * 60_000,
	prepareTimeoutMs: 40 * 60_000,
	snapshotTimeoutMs: 20 * 60_000,
	verifyTimeoutMs: 5 * 60_000,
	execTimeoutMs: 10 * 60_000,
};

const OUTPUT_TAIL = 256 * 1024;
export const TRANSIENT = [429, 503];
const READY_RETRY = [404, ...TRANSIENT];

export interface ClientExecOptions {
	timeoutMs: number;
	waitReady?: boolean;
	signal?: AbortSignal;
}

export class SandboxClient {
	readonly t: SandboxTimings;

	constructor(
		readonly api: SandboxApi,
		timings: Partial<SandboxTimings> = {},
	) {
		this.t = { ...DEFAULT_TIMINGS, ...timings };
	}

	async call<T>(fn: () => Promise<T>, opts: { retryOn?: readonly number[]; attempts?: number; signal?: AbortSignal } = {}): Promise<T> {
		const retryOn = opts.retryOn ?? [429];
		const attempts = opts.attempts ?? 5;
		for (let attempt = 1; ; attempt++) {
			try {
				return await fn();
			} catch (err) {
				const status = err instanceof ClientError || err instanceof ServerError ? err.statusCode : undefined;
				if (attempt >= attempts || status === undefined || !retryOn.includes(status) || opts.signal?.aborted) throw err;
				await sleep(this.t.pollMs, undefined, { signal: opts.signal });
			}
		}
	}

	async exec(id: string, command: string, opts: ClientExecOptions): Promise<ExecResult> {
		let stdout = "";
		let stderr = "";
		const exitCode = await this.execStream(id, command, {
			...opts,
			onData: (stream, data) => {
				if (stream === "stdout") stdout = (stdout + data).slice(-OUTPUT_TAIL);
				else stderr = (stderr + data).slice(-OUTPUT_TAIL);
			},
		});
		return { exitCode, stdout, stderr };
	}

	async execStream(id: string, command: string, opts: ClientExecOptions & Pick<ExecStreamOptions, "onData">): Promise<number> {
		const timeout = AbortSignal.timeout(opts.timeoutMs);
		const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
		const retry = opts.waitReady
			? { retryOn: READY_RETRY, attempts: Math.ceil(this.t.bootTimeoutMs / Math.max(this.t.pollMs, 1)) }
			: { retryOn: TRANSIENT };
		try {
			const stream = await this.call(() => this.api.exec(id, command, undefined, signal), { ...retry, signal });
			for await (const ev of stream) {
				if (ev.type === "exit") return ev.exit_code;
				opts.onData(ev.stream, ev.data);
			}
		} catch (err) {
			if (timeout.aborted) throw new Error(`exec in ${id} timed out after ${opts.timeoutMs}ms: ${command}`);
			throw err;
		}
		throw new Error(`exec in ${id} ended without an exit event: ${command}`);
	}

	async check(id: string, command: string, opts: ClientExecOptions): Promise<string> {
		const res = await this.exec(id, command, opts);
		if (res.exitCode !== 0) {
			throw new Error(`${command} exited ${res.exitCode} in ${id}: ${(res.stderr || res.stdout).trim().slice(-2000)}`);
		}
		return res.stdout;
	}

	async upload(
		id: string,
		path: string,
		data: string | Buffer,
		opts: { contentType?: SandboxUploadContentType; signal?: AbortSignal } = {},
	): Promise<void> {
		await this.call(() => this.api.upload(id, path, data, undefined, opts), { retryOn: TRANSIENT, signal: opts.signal });
	}

	async download(id: string, path: string, signal?: AbortSignal): Promise<Buffer> {
		const file = await this.call(() => this.api.download(id, path, undefined, signal), { retryOn: TRANSIENT, signal });
		return file.data;
	}

	async waitRunning(id: string): Promise<void> {
		const until = Date.now() + this.t.bootTimeoutMs;
		for (;;) {
			const { status } = await this.call(() => this.api.get(id), { retryOn: READY_RETRY });
			if (status === "running") return;
			if (status === "errored" || status === "terminated") throw new Error(`sandbox ${id} is ${status}`);
			if (Date.now() > until) throw new Error(`sandbox ${id} still ${status} after ${this.t.bootTimeoutMs}ms`);
			await sleep(this.t.pollMs);
		}
	}

	async terminate(id: string): Promise<void> {
		try {
			await this.call(() => this.api.terminate(id), { retryOn: TRANSIENT });
		} catch (err) {
			if (err instanceof ClientError && err.statusCode === 404) return;
			throw err;
		}
	}

	async terminateQuietly(id: string): Promise<void> {
		await this.terminate(id).catch((err) => log("warn", "terminate failed", { sandbox: id, error: errorMessage(err) }));
	}
}

let shared: SandboxClient | undefined;

export function sandboxClient(): SandboxClient {
	if (!shared) {
		const workspaceId = requireEnv("RENDER_WORKSPACE_ID");
		if (!workspaceId.startsWith("tea-")) throw new Error("RENDER_WORKSPACE_ID must be a tea-… workspace id");
		const render = new Render({ useLocalDev: false, token: requireEnv("RENDER_API_KEY"), ownerId: workspaceId });
		shared = new SandboxClient(render.experimental.sandboxes);
	}
	return shared;
}
