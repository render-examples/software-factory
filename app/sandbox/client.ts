import { setTimeout as sleep } from "node:timers/promises";
import { ClientError, Render, ServerError } from "@renderinc/sdk";
import type { SandboxesClient, SandboxUploadContentType } from "@renderinc/sdk/experimental";
import { loadSandboxConfig, type SandboxConfig } from "./config.js";
import { errorMessage, log } from "./shell.js";
import type { ExecResult } from "./types.js";

/** The subset of the SDK's SandboxesClient used here; tests substitute a fake. */
export type SandboxApi = Pick<SandboxesClient, "create" | "get" | "exec" | "upload" | "download" | "terminate"> & {
	snapshots: Pick<SandboxesClient["snapshots"], "create" | "get" | "list" | "delete">;
};

export interface SandboxTimings {
	/** Gap between status polls. */
	pollMs: number;
	bootTimeoutMs: number;
	/** Long build steps: tool install, clone, dependency install. */
	prepareTimeoutMs: number;
	snapshotTimeoutMs: number;
	verifyTimeoutMs: number;
	/** Default for `Sandbox.exec` when the caller gives no timeout. */
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
/**
 * A just-created sandbox can answer 404 to `get` and to `exec` for a short while (and `exec` can fail
 * briefly after it reports `running`), so readiness checks treat 404 as "not yet".
 */
const READY_RETRY = [404, ...TRANSIENT];

export interface ClientExecOptions {
	timeoutMs: number;
	waitReady?: boolean;
	signal?: AbortSignal;
}

/**
 * The SDK's sandbox client (@renderinc/sdk 1.2.0, experimental) plus what it leaves to callers:
 * - pacing: the Sandbox API allows 100 requests/min per workspace and the SDK neither paces nor retries 429s;
 * - retries on 429/503, which the SDK surfaces as errors;
 * - `waitRunning`: `create` returns while the sandbox is still `creating`, and there is no wait helper;
 * - `exec` collection: the SDK returns the raw event stream; `exec` here gathers output and the exit code.
 */
export class SandboxClient {
	readonly t: SandboxTimings;
	#nextRequestAt = 0;

	constructor(
		readonly api: SandboxApi,
		readonly cfg: Pick<SandboxConfig, "minRequestIntervalMs">,
		timings: Partial<SandboxTimings> = {},
	) {
		this.t = { ...DEFAULT_TIMINGS, ...timings };
	}

	static fromConfig(cfg: SandboxConfig): SandboxClient {
		// useLocalDev: false keeps sandbox calls on api.render.com even under a local workflows dev server.
		const render = new Render({ useLocalDev: false, token: cfg.apiKey, ownerId: cfg.workspaceId });
		return new SandboxClient(render.experimental.sandboxes, cfg);
	}

	/** Paces every API call and retries the given statuses (429 by default, which is never processed server-side). */
	async call<T>(
		fn: () => Promise<T>,
		opts: { retryOn?: readonly number[]; attempts?: number; signal?: AbortSignal } = {},
	): Promise<T> {
		const retryOn = opts.retryOn ?? [429];
		const attempts = opts.attempts ?? 5;
		for (let attempt = 1; ; attempt++) {
			const now = Date.now();
			const at = Math.max(now, this.#nextRequestAt);
			this.#nextRequestAt = at + this.cfg.minRequestIntervalMs;
			if (at > now) await sleep(at - now, undefined, { signal: opts.signal });
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
		const timeout = AbortSignal.timeout(opts.timeoutMs);
		const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
		const retry = opts.waitReady
			? { retryOn: READY_RETRY, attempts: Math.ceil(this.t.bootTimeoutMs / Math.max(this.t.pollMs, 1)) }
			: { retryOn: TRANSIENT };
		let stdout = "";
		let stderr = "";
		try {
			const stream = await this.call(() => this.api.exec(id, command, undefined, signal), { ...retry, signal });
			for await (const ev of stream) {
				if (ev.type === "exit") return { exitCode: ev.exit_code, stdout, stderr };
				if (ev.stream === "stdout") stdout = (stdout + ev.data).slice(-OUTPUT_TAIL);
				else stderr = (stderr + ev.data).slice(-OUTPUT_TAIL);
			}
		} catch (err) {
			if (timeout.aborted) throw new Error(`exec in ${id} timed out after ${opts.timeoutMs}ms: ${command}`);
			throw err;
		}
		throw new Error(`exec in ${id} ended without an exit event: ${command}`);
	}

	/** Like `exec`, but throws on a non-zero exit. Returns stdout. */
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

	/** Idempotent: a sandbox that no longer exists counts as terminated. */
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

let shared: Promise<SandboxClient> | undefined;

/** The process-wide client, configured from the environment on first use. */
export function sandboxClient(): Promise<SandboxClient> {
	shared ??= loadSandboxConfig().then(
		(cfg) => SandboxClient.fromConfig(cfg),
		(err: unknown) => {
			shared = undefined;
			throw err;
		},
	);
	return shared;
}
