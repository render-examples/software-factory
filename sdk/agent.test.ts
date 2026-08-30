import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, { value: string; ex?: number }>();

vi.mock("./redis.js", () => ({
  kv: async () => ({
    get: async (key: string) => store.get(key)?.value ?? null,
    set: async (key: string, value: string, opts?: { EX?: number }) => {
      store.set(key, { value, ex: opts?.EX });
    },
    del: async (key: string) => {
      store.delete(key);
    },
  }),
}));

import { Agent, agentTask } from "./agent.js";
import { appendMessage, getThread } from "./threads.js";
import { BLOB_THRESHOLD } from "./blobs.js";
import type { AgentRunner, AgentEvent, RunContext } from "./runner.js";
import type { ToolRegistry } from "./tools.js";

/** Runner that records the prompt it receives and yields a canned result. */
class RecordingRunner implements AgentRunner {
  readonly prompts: string[] = [];
  constructor(private readonly result: string = "done") {}
  async *run(ctx: RunContext): AsyncIterable<AgentEvent> {
    this.prompts.push(ctx.prompt);
    yield { type: "result", result: this.result };
  }
}

const emptyRegistry = { resolve: async () => [] } as unknown as ToolRegistry;

let seq = 0;
function interactiveTask(runner: AgentRunner) {
  // Unique id per task: agentTask registers into a process-wide registry.
  const agent = Agent({
    id: `test-agent-${seq++}`,
    prompt: "You are a test agent.",
    interactive: true,
  });
  return agentTask(agent, { runner, registry: emptyRegistry });
}

beforeEach(() => {
  store.clear();
});

describe("agentTask history replay", () => {
  it("resolves blob refs stored in thread history", async () => {
    const large = "x".repeat(BLOB_THRESHOLD + 1);
    await appendMessage("t1", "user", large);

    // Precondition: the message really was offloaded to a blob.
    const stored = (await getThread("t1"))!.messages[0].content;
    expect(stored).toMatch(/^\$blob:/);

    const runner = new RecordingRunner();
    await interactiveTask(runner)({ message: "follow up", threadId: "t1" });

    const prompt = runner.prompts[0];
    expect(prompt).not.toContain("$blob:");
    expect(prompt).toContain(large);
    expect(prompt).toContain("New message: follow up");
  });

  it("replays inline messages verbatim", async () => {
    await appendMessage("t1", "user", "first question");
    await appendMessage("t1", "assistant", "first answer");

    const runner = new RecordingRunner();
    await interactiveTask(runner)({ message: "second question", threadId: "t1" });

    expect(runner.prompts[0]).toContain("user: first question");
    expect(runner.prompts[0]).toContain("assistant: first answer");
  });

  it("keeps ordering when mixing capped and inline messages", async () => {
    const large = "y".repeat(BLOB_THRESHOLD + 1);
    await appendMessage("t1", "user", large);
    await appendMessage("t1", "assistant", "short reply");

    const runner = new RecordingRunner();
    await interactiveTask(runner)({ message: "next", threadId: "t1" });

    const prompt = runner.prompts[0];
    expect(prompt).not.toContain("$blob:");
    expect(prompt.indexOf(large)).toBeLessThan(prompt.indexOf("assistant: short reply"));
  });

  it("resolves refs in the incoming message too", async () => {
    const large = "z".repeat(BLOB_THRESHOLD + 1);
    // appendMessage caps it, giving us a real ref to pass as input.
    await appendMessage("other", "user", large);
    const ref = (await getThread("other"))!.messages[0].content;

    const runner = new RecordingRunner();
    await interactiveTask(runner)({ message: ref, threadId: "t1" });

    expect(runner.prompts[0]).toContain(large);
    expect(runner.prompts[0]).not.toContain("$blob:");
  });

  it("appends the assistant reply back to the thread", async () => {
    await appendMessage("t1", "user", "hi");
    await interactiveTask(new RecordingRunner("the answer"))({
      message: "hi",
      threadId: "t1",
    });

    const thread = await getThread("t1");
    expect(thread!.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "the answer",
    });
  });

  it("runs without history when the thread does not exist", async () => {
    const runner = new RecordingRunner();
    await interactiveTask(runner)({ message: "hello", threadId: "missing" });
    expect(runner.prompts[0]).toBe("hello");
  });

  it("leaves an expired ref in place rather than failing", async () => {
    await appendMessage("t1", "user", "see $blob:blob:gone:step:abc here");

    const runner = new RecordingRunner();
    await interactiveTask(runner)({ message: "next", threadId: "t1" });
    expect(runner.prompts[0]).toContain("$blob:blob:gone:step:abc");
  });
});
