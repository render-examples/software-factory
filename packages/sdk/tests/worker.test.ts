import { describe, it, expect } from "vitest";
import {
  MemoryJobQueue,
  buildEventRecord,
  type JobRecord,
  type RunStore,
} from "@render-factory/store";
import { idempotencyKey } from "@render-factory/store";
import { RunPaused, type AgentDefinition, type CompleteResult } from "@render-factory/engine";
import { createTestRuntime, mockModel } from "../src/testing.js";
import { runWorker, runWorkerLoop, buildJobProcessor } from "../src/worker.js";
import { defineTool } from "../src/authoring.js";

/** Poll `cond` until truthy or the deadline, so tests never hang on regressions. */
async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitUntil: condition not met within timeout");
}

/**
 * Seed an agent-root opening turn (`run.started` + `message.user`) so the run
 * record exists, exactly as the gateway records before enqueue. The worker's
 * `hasStarted()` guard then drives without duplicating these events.
 */
async function seedAgentRun(
  store: RunStore,
  runId: string,
  name: string,
  input: unknown,
  opts?: { threadId?: string },
): Promise<void> {
  await store.events.append(
    buildEventRecord(runId, { type: "run.started", input, trigger: "test", threadId: opts?.threadId }, { agentName: name, spanId: runId }),
  );
  await store.events.append(
    buildEventRecord(
      runId,
      { type: "message.user", content: [{ type: "text", text: typeof input === "string" ? input : JSON.stringify(input) }] },
      { agentName: name },
    ),
  );
}

function echoModel() {
  return mockModel((args) => {
    const lastUser = [...args.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
    return { content: [{ type: "text", text: `echo:${text}` }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" } as CompleteResult;
  });
}

describe("runWorkerLoop — claim loop core", () => {
  it("drains all enqueued jobs and completes them", async () => {
    const queue = new MemoryJobQueue();
    const store = { getRun: async () => undefined } as unknown as RunStore;
    const seen: string[] = [];
    const process = async (job: JobRecord) => {
      seen.push(job.id);
      await queue.complete(job.id);
    };

    for (let i = 0; i < 10; i++) {
      await queue.enqueue({ runId: `r${i}`, kind: "agent" });
    }

    const worker = runWorkerLoop(queue, process, { store, concurrency: 4, pollMs: 20 });
    await waitUntil(async () => (await queue.countByStatus()).done === 10);
    await worker.stop();

    expect(seen).toHaveLength(10);
    expect((await queue.countByStatus()).done).toBe(10);
  });

  it("never exceeds the configured concurrency", async () => {
    const queue = new MemoryJobQueue();
    const store = { getRun: async () => undefined } as unknown as RunStore;
    let active = 0;
    let maxActive = 0;
    const process = async (job: JobRecord) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 25));
      active -= 1;
      await queue.complete(job.id);
    };

    for (let i = 0; i < 12; i++) {
      await queue.enqueue({ runId: `r${i}`, kind: "agent" });
    }

    const worker = runWorkerLoop(queue, process, { store, concurrency: 3, pollMs: 20 });
    await waitUntil(async () => (await queue.countByStatus()).done === 12, 5000);
    await worker.stop();

    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1); // proves it actually parallelizes
  });

  it("wakes promptly on enqueue (NOTIFY/tail), not just on poll", async () => {
    const queue = new MemoryJobQueue();
    const store = { getRun: async () => undefined } as unknown as RunStore;
    const claimedAt: number[] = [];
    const process = async (job: JobRecord) => {
      claimedAt.push(Date.now());
      await queue.complete(job.id);
    };

    const worker = runWorkerLoop(queue, process, { store, concurrency: 1, pollMs: 10_000 });
    await new Promise((r) => setTimeout(r, 30)); // let it go idle
    const t0 = Date.now();
    await queue.enqueue({ runId: "r-wake", kind: "agent" });
    await waitUntil(() => claimedAt.length === 1, 1000);
    await worker.stop();

    expect(claimedAt[0] - t0).toBeLessThan(500); // woke well before the 10s poll
  });

  it("reaps a crashed runner's job and re-drives it (reaper integration)", async () => {
    const queue = new MemoryJobQueue();
    const store = { getRun: async () => undefined } as unknown as RunStore;
    const driven: string[] = [];
    const process = async (job: JobRecord) => {
      driven.push(job.id);
      await queue.complete(job.id);
    };

    const job = await queue.enqueue({ runId: "r-crash", kind: "agent" });
    // Simulate a crashed runner: claim the job under another worker and never ack.
    await queue.claim("dead-runner");
    expect((await queue.get(job.id))?.status).toBe("running");

    const worker = runWorkerLoop(queue, process, {
      store,
      concurrency: 1,
      pollMs: 20,
      staleMs: 10,
      reapIntervalMs: 15,
    });
    await waitUntil(async () => (await queue.get(job.id))?.status === "done", 3000);
    await worker.stop();

    expect(driven).toEqual([job.id]);
  });

  it("stop() drains in-flight work before resolving", async () => {
    const queue = new MemoryJobQueue();
    const store = { getRun: async () => undefined } as unknown as RunStore;
    let finished = false;
    let started = false;
    const process = async (job: JobRecord) => {
      started = true;
      await new Promise((r) => setTimeout(r, 40));
      finished = true;
      await queue.complete(job.id);
    };
    const job = await queue.enqueue({ runId: "r-drain", kind: "agent" });

    const worker = runWorkerLoop(queue, process, { store, concurrency: 1, pollMs: 20 });
    await waitUntil(() => started, 1000);
    // Stop is requested mid-flight; it must await the in-flight job, not abandon it.
    await worker.stop();

    expect(finished).toBe(true);
    expect((await queue.get(job.id))?.status).toBe("done");
  });
});

describe("buildJobProcessor — agent/resume routing + D3 reconciliation", () => {
  it("drives an agent turn in-process to completion and marks it done", async () => {
    const runtime = await createTestRuntime({ model: echoModel() });
    runtime.agentDefinitions.set("helper", {
      name: "helper", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "help", tools: [],
    });

    const runId = "agent-run-1";
    await seedAgentRun(runtime.store, runId, "helper", "hi there");
    const job = await runtime.jobQueue.enqueue({ runId, kind: "agent" });

    const process = buildJobProcessor(runtime);
    await process(job);

    const run = await runtime.store.getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.result).toBe("echo:hi there");
    expect((await runtime.jobQueue.get(job.id))?.status).toBe("done");
    // Opening events were not duplicated by the drive.
    const types = (await runtime.store.events.read(runId)).map((e) => e.type);
    expect(types.filter((t) => t === "run.started")).toHaveLength(1);
    expect(types.filter((t) => t === "message.user")).toHaveLength(1);
  });

  it("remembers prior turns via thread-scoped memory (new run per turn)", async () => {
    // Reply with how many user turns the model can see — proves cross-run memory.
    const runtime = await createTestRuntime({
      model: mockModel((args) => {
        const users = args.messages.filter((m) => m.role === "user").length;
        return { content: [{ type: "text", text: `users=${users}` }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" } as CompleteResult;
      }),
    });
    runtime.agentDefinitions.set("assistant", {
      name: "assistant", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "chat", tools: [], interactive: true,
    });
    const process = buildJobProcessor(runtime);

    // Turn 1 — its own run.
    await seedAgentRun(runtime.store, "turn-1", "assistant", "hello", { threadId: "t1" });
    await process(await runtime.jobQueue.enqueue({ runId: "turn-1", kind: "agent" }));
    expect((await runtime.store.getRun("turn-1"))?.result).toBe("users=1");

    // Turn 2 — a NEW run in the same thread; sees BOTH user turns.
    await seedAgentRun(runtime.store, "turn-2", "assistant", "again", { threadId: "t1" });
    await process(await runtime.jobQueue.enqueue({ runId: "turn-2", kind: "agent" }));
    expect((await runtime.store.getRun("turn-2"))?.result).toBe("users=2");
    expect((await runtime.store.getRun("turn-2"))?.status).toBe("completed"); // turn-end is NOT a pause
  });

  it("completes (never requeues) a job whose turn failed (D3)", async () => {
    const runtime = await createTestRuntime({ model: mockModel(() => { throw new Error("model boom"); }) });
    runtime.agentDefinitions.set("flaky", {
      name: "flaky", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "x", tools: [],
    });

    const runId = "agent-run-fail";
    await seedAgentRun(runtime.store, runId, "flaky", "go");
    const job = await runtime.jobQueue.enqueue({ runId, kind: "agent" });

    await buildJobProcessor(runtime)(job);

    expect((await runtime.store.getRun(runId))?.status).toBe("failed");
    expect((await runtime.jobQueue.get(job.id))?.status).toBe("done"); // settled, not requeued
  });

  it("settles a paused agent turn (HITL within the turn) as done (not failed)", async () => {
    const KEY = "RENDER_FACTORY_STRICT_APPROVAL";
    process.env[KEY] = "1";
    try {
      const toolSources = new Map([
        ["deploy", defineTool({ name: "deploy", description: "ship", inputSchema: {}, async invoke() { return "deployed"; } })],
      ]);
      const runtime = await createTestRuntime({
        model: mockModel(() => ({ content: [{ type: "tool_use", id: "tc1", name: "deploy", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" } as CompleteResult)),
        toolSources,
      });
      runtime.agentDefinitions.set("deployer", {
        name: "deployer", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "deploy",
        tools: ["deploy"], permissions: { requireApproval: ["deploy"] },
      });

      const runId = "agent-run-paused";
      await seedAgentRun(runtime.store, runId, "deployer", "ship it");
      const job = await runtime.jobQueue.enqueue({ runId, kind: "agent" });

      await buildJobProcessor(runtime)(job);

      expect((await runtime.store.getRun(runId))?.status).toBe("paused");
      expect((await runtime.jobQueue.get(job.id))?.status).toBe("done");
    } finally {
      delete process.env[KEY];
    }
  });

  it("requeues with backoff on a genuine crash (no such agent, run not terminal)", async () => {
    const runtime = await createTestRuntime();
    const runId = "agent-run-missing";
    await seedAgentRun(runtime.store, runId, "ghost", "x"); // 'ghost' not registered
    const job = await runtime.jobQueue.enqueue({ runId, kind: "agent" });

    await buildJobProcessor(runtime)(job);

    const after = await runtime.jobQueue.get(job.id);
    expect(after?.status).toBe("queued"); // requeued for crash recovery
    expect(after?.lastError).toMatch(/no agent named/);
    expect(Date.parse(after!.availableAt)).toBeGreaterThan(Date.now() - 50); // backoff applied
  });

  it("settles a cancelled run without driving it", async () => {
    let calls = 0;
    const runtime = await createTestRuntime({ model: mockModel(() => { calls += 1; return { content: [{ type: "text", text: "x" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" } as CompleteResult; }) });
    runtime.agentDefinitions.set("helper", {
      name: "helper", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "h", tools: [],
    });

    const runId = "agent-run-cancel";
    await seedAgentRun(runtime.store, runId, "helper", "x");
    await runtime.cancelStore.requestCancel(runId);
    const job = await runtime.jobQueue.enqueue({ runId, kind: "agent" });

    await buildJobProcessor(runtime)(job);

    expect(calls).toBe(0); // never driven
    expect((await runtime.jobQueue.get(job.id))?.status).toBe("done");
  });

  it("drives a resume job: re-drives a paused run once the approval resolves", async () => {
    const KEY = "RENDER_FACTORY_STRICT_APPROVAL";
    process.env[KEY] = "1";
    try {
      let invoked = 0;
      const toolSources = new Map([
        ["deploy", defineTool({ name: "deploy", description: "ship", inputSchema: {}, async invoke() { invoked += 1; return "deployed"; } })],
      ]);
      const responses: CompleteResult[] = [
        { content: [{ type: "tool_use", id: "tc1", name: "deploy", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" },
        { content: [{ type: "text", text: "shipped" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
      ];
      let i = 0;
      const runtime = await createTestRuntime({ model: mockModel(() => responses[Math.min(i++, responses.length - 1)]), toolSources });
      runtime.agentDefinitions.set("deployer", {
        name: "deployer",
        model: { provider: "anthropic", model: "claude-haiku-4-5" },
        systemPrompt: "deploy",
        tools: ["deploy"],
        permissions: { requireApproval: ["deploy"] },
      });

      const runId = "resume-run-1";
      // Drive once to the pause point (records run.started + run.paused).
      await expect(
        runtime.dispatcher!.dispatch("deployer", "go", { runId, idempotencyKey: runId }),
      ).rejects.toBeInstanceOf(RunPaused);
      expect((await runtime.store.getRun(runId))?.status).toBe("paused");

      // Operator resolves the approval out-of-band, then a resume job is enqueued.
      await runtime.store.events.append(
        buildEventRecord(runId, { type: "input.provided", inputRequestId: idempotencyKey(runId, "input:approval:tc1"), kind: "approval", approved: true }, { agentName: "deployer" }),
      );
      const job = await runtime.jobQueue.enqueue({ runId, kind: "resume" });

      await buildJobProcessor(runtime)(job);

      expect(invoked).toBe(1);
      expect((await runtime.store.getRun(runId))?.status).toBe("completed");
      expect((await runtime.jobQueue.get(job.id))?.status).toBe("done");
    } finally {
      delete process.env[KEY];
    }
  });
});

describe("runWorker — end-to-end (wired loop + real agent turn)", () => {
  it("claims and drives an enqueued agent turn to completion over the loop", async () => {
    const runtime = await createTestRuntime({ model: echoModel() });
    runtime.agentDefinitions.set("helper", {
      name: "helper", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "h", tools: [],
    });

    const runId = "agent-e2e";
    await seedAgentRun(runtime.store, runId, "helper", "hello world");

    const worker = runWorker(runtime, { concurrency: 2, pollMs: 50, staleMs: 1000 });
    await runtime.jobQueue.enqueue({ runId, kind: "agent" });

    await waitUntil(async () => (await runtime.store.getRun(runId))?.status === "completed", 3000);
    await worker.stop();

    expect((await runtime.store.getRun(runId))?.result).toBe("echo:hello world");
    expect((await runtime.jobQueue.countByStatus()).done).toBe(1);
  });
});
