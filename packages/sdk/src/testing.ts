import type { ModelClient, CompleteArgs, CompleteResult } from "@render-agents/engine";
import { createMemoryStore } from "@render-agents/store";
import { createRuntime, type AgentRuntime, type CreateRuntimeOptions } from "./runtime.js";

/** A programmable `ModelClient` for tests: the handler decides each completion. */
export function mockModel(
  handler: (args: CompleteArgs) => CompleteResult | Promise<CompleteResult>,
): ModelClient {
  return {
    async complete(args: CompleteArgs): Promise<CompleteResult> {
      return handler(args);
    },
  };
}

/**
 * In-memory runtime for tests: memory store, provided/mock model, and the
 * default in-process dispatcher (so `.task()` runs in-process with the same
 * observable behavior as `.run()`). Runs the *real* DefaultRunner — only the
 * model and store are swapped.
 */
export function createTestRuntime(opts?: Partial<CreateRuntimeOptions>): Promise<AgentRuntime> {
  return createRuntime({
    // Hermetic by default: ignore ambient Render env (RENDER_USE_LOCAL_DEV etc.)
    // so the suite uses the in-process dispatcher even when run inside a
    // `render workflows dev` shell. Callers can still pass an explicit dispatcher.
    autoDetectDispatcher: false,
    ...opts,
    store: opts?.store ?? createMemoryStore(),
  });
}
