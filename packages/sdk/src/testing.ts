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
 * In-memory runtime for tests: memory store, provided/mock model, and no
 * dispatcher (so `.task()` falls back to `.run()`). Runs the *real* DefaultRunner
 * — only the model and store are swapped.
 */
export function createTestRuntime(opts?: Partial<CreateRuntimeOptions>): Promise<AgentRuntime> {
  return createRuntime({
    ...opts,
    store: opts?.store ?? createMemoryStore(),
    dispatcher: undefined,
  });
}
