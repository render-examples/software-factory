import type { ModelClient, CompleteArgs, CompleteResult } from "@render-agents/engine";
import type { AgentRuntime, CreateRuntimeOptions } from "./runtime.js";

export function mockModel(
  _handler: (args: CompleteArgs) => CompleteResult | Promise<CompleteResult>,
): ModelClient {
  throw new Error("not implemented");
}

export function createTestRuntime(_opts?: Partial<CreateRuntimeOptions>): Promise<AgentRuntime> {
  throw new Error("not implemented");
}
