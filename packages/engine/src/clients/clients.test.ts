import { describe, it, expect } from "vitest";
import type { CompleteArgs, CompleteResult, ModelClient } from "../model.js";
import { withRetry } from "./retry.js";
import { resolveClient } from "./index.js";

const SIGNAL = AbortSignal.timeout(5000);
const DUMMY_ARGS: CompleteArgs = {
  model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  system: "test",
  tools: [],
  messages: [],
  signal: SIGNAL,
};

const OK_RESULT: CompleteResult = {
  content: [{ type: "text", text: "hello" }],
  usage: { inputTokens: 10, outputTokens: 5 },
  stopReason: "end_turn",
};

function failingClient(failures: number, status = 429): ModelClient {
  let calls = 0;
  return {
    async complete(_args: CompleteArgs): Promise<CompleteResult> {
      calls++;
      if (calls <= failures) {
        const err = new Error(`rate limited`) as Error & { status: number };
        err.status = status;
        throw err;
      }
      return OK_RESULT;
    },
  };
}

describe("withRetry", () => {
  it("succeeds on first try without retrying", async () => {
    const client = failingClient(0);
    const retrying = withRetry(client, { maxRetries: 3, initialDelayMs: 1 });
    const result = await retrying.complete(DUMMY_ARGS);
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("retries on 429 and succeeds after transient failures", async () => {
    const client = failingClient(2, 429);
    const retrying = withRetry(client, { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 10 });
    const result = await retrying.complete(DUMMY_ARGS);
    expect(result.stopReason).toBe("end_turn");
  });

  it("retries on 503 and succeeds", async () => {
    const client = failingClient(1, 503);
    const retrying = withRetry(client, { maxRetries: 2, initialDelayMs: 1 });
    const result = await retrying.complete(DUMMY_ARGS);
    expect(result.usage.inputTokens).toBe(10);
  });

  it("does NOT retry on 400 (non-retryable)", async () => {
    const client = failingClient(1, 400);
    const retrying = withRetry(client, { maxRetries: 3, initialDelayMs: 1 });
    await expect(retrying.complete(DUMMY_ARGS)).rejects.toThrow("rate limited");
  });

  it("exhausts retries and throws the last error", async () => {
    const client = failingClient(5, 500);
    const retrying = withRetry(client, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 });
    await expect(retrying.complete(DUMMY_ARGS)).rejects.toThrow("rate limited");
  });

  it("stops retrying when signal is aborted", async () => {
    const controller = new AbortController();
    const client = failingClient(10, 429);
    const retrying = withRetry(client, { maxRetries: 10, initialDelayMs: 50 });

    controller.abort();
    const args = { ...DUMMY_ARGS, signal: controller.signal };
    await expect(retrying.complete(args)).rejects.toThrow();
  });
});

describe("withRetry — streaming (D13)", () => {
  it("forwards stream() so the runner's feature-detection still streams through the retry wrapper", async () => {
    const client: ModelClient = {
      async complete() { return OK_RESULT; },
      async *stream() {
        yield { type: "text_delta", text: "hel" };
        yield { type: "text_delta", text: "lo" };
        return OK_RESULT;
      },
    };
    const retrying = withRetry(client, { maxRetries: 3, initialDelayMs: 1 });
    expect(typeof retrying.stream).toBe("function");

    const gen = retrying.stream!(DUMMY_ARGS);
    const deltas: string[] = [];
    let next = await gen.next();
    while (!next.done) {
      if (next.value.type === "text_delta") deltas.push(next.value.text);
      next = await gen.next();
    }
    expect(deltas.join("")).toBe("hello");
    expect(next.value).toEqual(OK_RESULT);
  });

  it("does NOT expose stream() when the underlying client has none (preserves complete() fallback)", () => {
    const retrying = withRetry(failingClient(0), { maxRetries: 1, initialDelayMs: 1 });
    expect(retrying.stream).toBeUndefined();
  });

  it("retries establishing a stream on a transient error before the first token", async () => {
    let calls = 0;
    const client: ModelClient = {
      async complete() { return OK_RESULT; },
      // eslint-disable-next-line require-yield
      async *stream() {
        calls++;
        if (calls === 1) {
          const err = new Error("rate limited") as Error & { status: number };
          err.status = 429;
          throw err;
        }
        yield { type: "text_delta", text: "ok" };
        return OK_RESULT;
      },
    };
    const retrying = withRetry(client, { maxRetries: 3, initialDelayMs: 1 });
    const gen = retrying.stream!(DUMMY_ARGS);
    const deltas: string[] = [];
    let next = await gen.next();
    while (!next.done) {
      if (next.value.type === "text_delta") deltas.push(next.value.text);
      next = await gen.next();
    }
    expect(calls).toBe(2);
    expect(deltas.join("")).toBe("ok");
  });
});

describe("resolveClient", () => {
  it("returns a client for anthropic provider", () => {
    const client = resolveClient({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(client).toBeDefined();
    expect(typeof client.complete).toBe("function");
    expect(typeof client.stream).toBe("function");
  });

  it("returns a client for openai provider", () => {
    const client = resolveClient({ provider: "openai", model: "gpt-4o" });
    expect(client).toBeDefined();
    expect(typeof client.complete).toBe("function");
  });

  it("throws for unsupported provider", () => {
    expect(() =>
      resolveClient({ provider: "unsupported" as "anthropic", model: "x" }),
    ).toThrow(/Unsupported provider/);
  });
});
