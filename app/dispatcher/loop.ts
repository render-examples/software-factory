import {
	claimForDispatch,
	finishRun,
	requeueForDispatch,
} from "../store/index.js";
import { point } from "../telemetry/index.js";

const MAX_DISPATCH_ATTEMPTS = 8;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 120_000;

/** Errors that indicate the task config is wrong, not a transient failure. */
function isTerminalError(status: number): boolean {
	return status >= 400 && status < 500 && status !== 429;
}

export type StartTaskFn = (
	taskPath: string,
	args: unknown[],
) => Promise<unknown>;

export interface DispatcherOptions {
	pollIntervalMs?: number;
	batchSize?: number;
	workflowSlug: string;
	startTask: StartTaskFn;
}

/**
 * Run the dispatch loop. Returns a stop function.
 * Polls for queued runs and starts their workflow tasks.
 */
export function startDispatchLoop(opts: DispatcherOptions): {
	stop: () => void;
} {
	const pollInterval = opts.pollIntervalMs ?? 2_000;
	const batchSize = opts.batchSize ?? 10;
	let running = true;
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function tick(): Promise<void> {
		if (!running) return;

		try {
			const claimed = await claimForDispatch(batchSize);
			for (const run of claimed) {
				if (!running) break;
				await dispatchOne(run, opts);
			}
		} catch (err) {
			console.error("dispatcher: poll error:", err);
		}

		if (running) {
			timer = setTimeout(() => {
				void tick();
			}, pollInterval);
		}
	}

	void tick();

	return {
		stop() {
			running = false;
			if (timer) clearTimeout(timer);
		},
	};
}

async function dispatchOne(
	run: { id: string; workflow: string },
	opts: DispatcherOptions,
): Promise<void> {
	const taskPath = `${opts.workflowSlug}/${run.workflow}`;
	try {
		await opts.startTask(taskPath, [{ runId: run.id }]);
		try {
			await point(run.id, "run.dispatched", {
				taskPath,
				workflow: run.workflow,
			});
		} catch {
			/* telemetry must not fail dispatch */
		}
	} catch (err) {
		const status = extractHttpStatus(err);
		const terminal = status !== null && isTerminalError(status);

		const { getRun } = await import("../store/runs.js");
		const current = await getRun(run.id);
		const attempts = current?.dispatchAttempts ?? 1;

		if (terminal || attempts >= MAX_DISPATCH_ATTEMPTS) {
			await finishRun(run.id, "failed", {
				outcome: "dispatch_failed",
				summary:
					`dispatch failed after ${attempts} attempt(s): ${err instanceof Error ? err.message : String(err)}`.slice(
						0,
						1000,
					),
			});
			console.error(`dispatcher: run ${run.id} failed permanently:`, err);
		} else {
			const delayMs = Math.min(
				BASE_DELAY_MS * 2 ** (attempts - 1) + Math.random() * 1_000,
				MAX_DELAY_MS,
			);
			const dispatchAfter = new Date(Date.now() + delayMs);
			await requeueForDispatch(run.id, dispatchAfter);
			console.warn(
				`dispatcher: run ${run.id} requeued (attempt ${attempts}), next at ${dispatchAfter.toISOString()}`,
			);
		}
	}
}

function extractHttpStatus(err: unknown): number | null {
	if (err && typeof err === "object" && "status" in err) {
		const s = (err as { status: unknown }).status;
		if (typeof s === "number") return s;
	}
	return null;
}
