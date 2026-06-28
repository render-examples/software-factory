import type { ModelClient, CompleteArgs, CompleteResult, RetryPolicy } from "../model.js";

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  retryableStatuses: [429, 500, 502, 503, 504],
};

/**
 * Wraps a ModelClient with transparent retry on transient failures.
 *
 * Retries do NOT consume additional token budget or emit loop events.
 * The wrapped client sees only the final result (or final error after
 * all retries are exhausted). Honors Retry-After headers when present.
 */
export function withRetry(
  client: ModelClient,
  policy: Partial<RetryPolicy> = {},
): ModelClient {
  const p: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy };

  return {
    async complete(args: CompleteArgs): Promise<CompleteResult> {
      let lastError: unknown;
      for (let attempt = 0; attempt <= p.maxRetries; attempt++) {
        try {
          return await client.complete(args);
        } catch (err) {
          lastError = err;
          if (attempt >= p.maxRetries) break;
          if (args.signal.aborted) break;
          if (!isRetryable(err, p.retryableStatuses)) break;

          const delayMs = computeDelay(attempt, p, err);
          await sleep(delayMs, args.signal);
        }
      }
      throw lastError;
    },
  };
}

function isRetryable(err: unknown, retryableStatuses: number[]): boolean {
  if (err instanceof Error) {
    // Network errors (fetch failures, socket hangups)
    if (err.message.includes("ECONNRESET") || err.message.includes("ETIMEDOUT")) return true;
    if (err.message.includes("fetch failed") || err.message.includes("network")) return true;
  }
  const status = extractStatus(err);
  if (status !== undefined) {
    return retryableStatuses.includes(status);
  }
  return false;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.status === "number") return obj.status;
    if (typeof obj.statusCode === "number") return obj.statusCode;
    if (typeof obj.code === "number" && obj.code >= 400) return obj.code;
  }
  return undefined;
}

function computeDelay(attempt: number, policy: RetryPolicy, err: unknown): number {
  const retryAfter = extractRetryAfter(err);
  if (retryAfter !== undefined) {
    return Math.min(retryAfter * 1000, policy.maxDelayMs);
  }
  const base = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt);
  const jitter = base * (0.5 + Math.random() * 0.5);
  return Math.min(jitter, policy.maxDelayMs);
}

function extractRetryAfter(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    // SDK errors often have headers or a retryAfter field
    if (typeof obj.retryAfter === "number") return obj.retryAfter;
    const headers = obj.headers as Record<string, string> | undefined;
    const raw = headers?.["retry-after"];
    if (raw) {
      // Retry-After may be delta-seconds or an HTTP-date (RFC 7231).
      const seconds = Number(raw);
      if (!isNaN(seconds)) return seconds;
      const dateMs = Date.parse(raw);
      if (!isNaN(dateMs)) return Math.max(0, (dateMs - Date.now()) / 1000);
    }
  }
  return undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      // Remove the listener so it doesn't accumulate across retries.
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
