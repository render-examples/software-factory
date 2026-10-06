import { setTimeout as sleep } from "node:timers/promises";
import { ClientError, ServerError } from "@renderinc/sdk";

/** Process-wide pacer for the Render 100 req/min workspace limit. */
let nextRequestAt = 0;

let minIntervalMs = 600;

export function setPacerInterval(ms: number): void {
	minIntervalMs = ms;
}

export function getPacerInterval(): number {
	return minIntervalMs;
}

/** Reset pacer state (for tests). */
export function resetPacer(): void {
	nextRequestAt = 0;
}

/**
 * Pace an API call and retry on 429/503 up to `attempts` times.
 * Every call is spaced by at least `minIntervalMs` process-wide.
 */
export async function paced<T>(
	fn: () => Promise<T>,
	opts: {
		retryOn?: readonly number[];
		attempts?: number;
		signal?: AbortSignal;
	} = {},
): Promise<T> {
	const retryOn = opts.retryOn ?? [429, 503];
	const attempts = opts.attempts ?? 5;
	for (let attempt = 1; ; attempt++) {
		const now = Date.now();
		const at = Math.max(now, nextRequestAt);
		nextRequestAt = at + minIntervalMs;
		if (at > now) await sleep(at - now, undefined, { signal: opts.signal });
		try {
			return await fn();
		} catch (err) {
			const status =
				err instanceof ClientError || err instanceof ServerError
					? err.statusCode
					: undefined;
			if (
				attempt >= attempts ||
				status === undefined ||
				!retryOn.includes(status) ||
				opts.signal?.aborted
			) {
				throw err;
			}
			await sleep(minIntervalMs, undefined, { signal: opts.signal });
		}
	}
}
