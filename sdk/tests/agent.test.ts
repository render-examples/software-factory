import { describe, expect, it } from "vitest";
import { createMemoryFactoryStore } from "#factory/store";
import { Agent, agentTask, md } from "../agent.js";
import type { Hook } from "../hooks.js";
import type { AgentEvent, AgentRunner, RunContext } from "../runner.js";

class RecordingRunner implements AgentRunner {
  context?: RunContext;

  async *run(context: RunContext): AsyncIterable<AgentEvent> {
    this.context = context;
    yield { type: "result", result: "done" };
  }
}

const store = createMemoryFactoryStore();

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
      store,
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

  it("records a generic child agent run and usage", async () => {
    const hierarchyStore = createMemoryFactoryStore();
    await hierarchyStore.runs.ensureRun({
      id: "root-run",
      rootRunId: "root-run",
      kind: "workflow",
      name: "pipeline",
    });
    const runner: AgentRunner = {
      async *run() {
        yield {
          type: "usage",
          usage: {
            inputTokens: 12,
            outputTokens: 4,
            model: "test-model",
          },
        };
        yield { type: "result", result: "done" };
      },
    };
    const run = agentTask(
      Agent({ id: "child-agent", prompt: "system", tools: [] }),
      { runner, store: hierarchyStore },
    );

    await run({
      message: "work",
      run: {
        id: "child-run",
        rootRunId: "root-run",
        parentRunId: "root-run",
        parentStepKey: "analysis",
      },
    });

    expect(await hierarchyStore.runs.getRun("child-run")).toMatchObject({
      kind: "agent",
      name: "child-agent",
      status: "completed",
      rootRunId: "root-run",
      parentRunId: "root-run",
      parentStepKey: "analysis",
      totalInputTokens: 12,
      totalOutputTokens: 4,
      totalModelCalls: 1,
    });
    expect(
      (await hierarchyStore.events.readRun("child-run")).map(
        (event) => event.type,
      ),
    ).toContain("agent.usage");
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
      { runner, hooks: [blocker], store },
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
      { runner, store },
    );

    await expect(run({ message: "work" })).rejects.toThrow(
      "model unavailable",
    );
  });

  it("terminalizes an agent run after its retry budget is exhausted", async () => {
    const failureStore = createMemoryFactoryStore();
    const runner: AgentRunner = {
      async *run() {
        yield { type: "error", error: new Error("model unavailable") };
      },
    };
    const run = agentTask(
      Agent({ id: "terminal-failure-test", prompt: "system", tools: [] }),
      { runner, store: failureStore },
    );
    const input = {
      message: "work",
      run: {
        id: "terminal-failure-run",
        rootRunId: "terminal-failure-run",
      },
    };

    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(run(input)).rejects.toThrow("model unavailable");
    }
    expect(await failureStore.runs.getRun(input.run.id)).toMatchObject({
      status: "failed",
      failureCount: 4,
      errorCode: "attempts_exhausted",
    });
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
      agentTask(agent, { runner: noResult, store })({
        message: "work",
      }),
    ).rejects.toThrow(/no result/);
    await expect(
      agentTask(agent, {
        runner: multipleResults,
        store,
      })({ message: "work" }),
    ).rejects.toThrow(/multiple results/);
  });
});
