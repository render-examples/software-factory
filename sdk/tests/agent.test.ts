import { describe, expect, it } from "vitest";
import { Agent, agentTask, md } from "../agent.js";
import type { Hook } from "../hooks.js";
import type { AgentEvent, AgentRunner, RunContext } from "../runner.js";
import type { ToolRegistry } from "../tools.js";

class RecordingRunner implements AgentRunner {
  context?: RunContext;

  async *run(context: RunContext): AsyncIterable<AgentEvent> {
    this.context = context;
    yield { type: "result", result: "done" };
  }
}

const emptyRegistry = {
  resolve: async () => [],
} as unknown as ToolRegistry;

describe("Agent", () => {
  it("validates required configuration", () => {
    expect(() => Agent({ id: "", prompt: "prompt" })).toThrow(/id/);
    expect(() => Agent({ id: "agent", prompt: "" })).toThrow(/prompt/);
  });

  it("dedents markdown prompts", () => {
    expect(md`
      first
        second
    `).toBe("first\n  second");
  });
});

describe("agentTask", () => {
  it("defaults to an empty registry rather than host built-ins", async () => {
    const run = agentTask(
      Agent({ id: "default-registry-test", prompt: "system", tools: ["Bash"] }),
      { runner: new RecordingRunner() },
    );
    await expect(run({ message: "work" })).rejects.toThrow(/Bash.*not found/);
  });

  it("forwards the configured prompt, model, budget, and tools", async () => {
    const runner = new RecordingRunner();
    const agent = Agent({
      id: "analyst-test",
      prompt: "system",
      model: "medium",
      budget: { maxIterations: 12 },
      tools: [],
    });

    const result = await agentTask(agent, {
      runner,
      registry: emptyRegistry,
    })({ message: "work item" });

    expect(result).toBe("done");
    expect(runner.context).toMatchObject({
      agentId: "analyst-test",
      prompt: "work item",
      systemPrompt: "system",
      maxTurns: 12,
      model: "medium",
      tools: [],
    });
  });

  it("bridges hook rejection to the runner's pre-tool policy", async () => {
    let intercepted: unknown;
    const runner: AgentRunner = {
      async *run(context) {
        if (!context.interceptToolCall) {
          throw new Error("missing tool interceptor");
        }
        intercepted = await context.interceptToolCall({
          type: "tool_call",
          id: "tool-1",
          name: "Bash",
          input: { command: "rm -rf /" },
        });
        yield { type: "result", result: "done" };
      },
    };
    const blocker: Hook = {
      name: "blocker",
      on: ["tool_call"],
      async handle() {
        return { action: "reject", reason: "blocked" };
      },
    };

    await agentTask(
      Agent({ id: "policy-test", prompt: "system", tools: [] }),
      { runner, registry: emptyRegistry, hooks: [blocker] },
    )({ message: "work" });

    expect(intercepted).toEqual({ action: "reject", reason: "blocked" });
  });

  it("throws runner failures instead of returning an empty success", async () => {
    const runner: AgentRunner = {
      async *run() {
        yield { type: "error", error: new Error("model unavailable") };
      },
    };
    const run = agentTask(
      Agent({ id: "failure-test", prompt: "system", tools: [] }),
      { runner, registry: emptyRegistry },
    );

    await expect(run({ message: "work" })).rejects.toThrow(
      "model unavailable",
    );
  });

  it("requires exactly one terminal result", async () => {
    const noResult: AgentRunner = {
      async *run() {
        yield { type: "text", text: "unfinished" };
      },
    };
    const multipleResults: AgentRunner = {
      async *run() {
        yield { type: "result", result: "first" };
        yield { type: "result", result: "second" };
      },
    };
    const agent = Agent({ id: "terminal-test", prompt: "system", tools: [] });

    await expect(
      agentTask(agent, { runner: noResult, registry: emptyRegistry })({
        message: "work",
      }),
    ).rejects.toThrow(/no result/);
    await expect(
      agentTask(agent, {
        runner: multipleResults,
        registry: emptyRegistry,
      })({ message: "work" }),
    ).rejects.toThrow(/multiple results/);
  });
});
