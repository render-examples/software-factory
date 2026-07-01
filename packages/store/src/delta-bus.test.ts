import { describe, it, expect } from "vitest";
import { DeltaQueue, MemoryDeltaBus, type StreamDelta } from "./delta-bus.js";
import { createMemoryStore, buildEventRecord } from "./memory-store.js";

/** Drain a subscription into an array until `signal` aborts. */
function collect(
  bus: MemoryDeltaBus,
  filter: { runId?: string; threadId?: string },
  signal: AbortSignal,
): { got: StreamDelta[]; done: Promise<void> } {
  const got: StreamDelta[] = [];
  const done = (async () => {
    for await (const d of bus.subscribe(filter, signal)) got.push(d);
  })();
  return { got, done };
}

describe("MemoryDeltaBus", () => {
  it("delivers deltas to a run subscriber and stops on abort", async () => {
    const bus = new MemoryDeltaBus();
    const controller = new AbortController();
    const { got, done } = collect(bus, { runId: "r1" }, controller.signal);
    await Promise.resolve(); // let the subscription register

    await bus.publish({ runId: "r1", agentName: "a", seq: 1, text: "Hello " });
    await bus.publish({ runId: "r1", agentName: "a", seq: 2, text: "world" });
    await Promise.resolve();

    controller.abort();
    await done;

    expect(got.map((d) => d.text).join("")).toBe("Hello world");
    expect(got.map((d) => d.seq)).toEqual([1, 2]);
  });

  it("filters by runId and by threadId, ignoring non-matching deltas", async () => {
    const bus = new MemoryDeltaBus();
    const controller = new AbortController();
    const run = collect(bus, { runId: "r1" }, controller.signal);
    const thread = collect(bus, { threadId: "t1" }, controller.signal);
    await Promise.resolve();

    await bus.publish({ runId: "r1", threadId: "t1", agentName: "a", seq: 1, text: "match" });
    await bus.publish({ runId: "r2", threadId: "t2", agentName: "a", seq: 1, text: "other" });
    await Promise.resolve();

    controller.abort();
    await Promise.all([run.done, thread.done]);

    expect(run.got.map((d) => d.text)).toEqual(["match"]);
    expect(thread.got.map((d) => d.text)).toEqual(["match"]);
  });
});

describe("DeltaQueue backpressure", () => {
  it("drops the oldest items when a slow subscriber exceeds the bound", async () => {
    const q = new DeltaQueue<number>(3);
    const ac = new AbortController();
    const got: number[] = [];
    const done = (async () => {
      for await (const n of q.drain(ac.signal)) got.push(n);
    })();
    await Promise.resolve(); // let drain park on the wake

    for (let i = 0; i < 5; i++) q.push(i); // 0..4 pushed, only the last 3 kept
    await new Promise((r) => setTimeout(r, 10));

    ac.abort();
    await done;

    expect(got).toEqual([2, 3, 4]);
  });
});

describe("transient events are never persisted (D13)", () => {
  it("rejects appending a text.delta to the event log", async () => {
    const store = createMemoryStore();
    await expect(
      store.events.append(
        buildEventRecord("r1", { type: "text.delta", agentName: "a", text: "hi" }, { agentName: "a" }),
      ),
    ).rejects.toThrow(/transient/i);
  });
});
