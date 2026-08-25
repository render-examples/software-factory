import { describe, it, expect } from "vitest";
import { idempotencyKey, buildEventRecord } from "@render-factory/store";
import {
  workflow,
  bindWorkflow,
  runWorker,
  submitRootRun,
  defineTool,
  type AgentDefinition,
  type RootDispatchJob,
  type TaskDispatcher,
  type WorkflowDefinition,
} from "@render-factory/sdk";
import { createTestRuntime, mockModel } from "@render-factory/sdk/testing";
import { createGatewayApp } from "../src/index.js";

/** A dispatcher that records workflow-root triggers (stands in for Render's startTask). */
function recordingRenderDispatcher(triggered: RootDispatchJob[]): TaskDispatcher {
  return {
    dispatch: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 } }),
    dispatchRoot: async (job) => { triggered.push(job); },
  };
}

/** Poll until `cond` is truthy or the deadline, so tests never hang on a regression. */
async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitUntil: condition not met within timeout");
}

describe("gateway workflow lane (Lane A) — trigger, don't execute at the gateway", () => {
  it("POST /workflows/:name records run.started + triggers the workflow lane (no run_jobs, no inline run)", async () => {
    const runtime = await createTestRuntime();
    const triggered: RootDispatchJob[] = [];
    (runtime as { dispatcher: TaskDispatcher }).dispatcher = recordingRenderDispatcher(triggered);
    let handlerRan = 0;
    const wf = workflow(async (ctx) => {
      await ctx.step("work", async () => { handlerRan += 1; return "ok"; });
      return "done";
    });
    bindWorkflow(wf, "wf", runtime);
    const workflows = new Map<string, WorkflowDefinition>([["wf", wf]]);
    const app = createGatewayApp({ runtime, workflows, disableAuth: true });

    const res = await app.request("/workflows/wf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { x: 1 }, trigger: "api" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    const runId = body.id;

    // Returned in ms: run.started recorded, the workflow lane triggered
    // (fire-and-forget), the handler NOT run at the gateway, and NO run_jobs row.
    expect(handlerRan).toBe(0);
    expect(triggered).toEqual([{ workflow: "wf", runId, plan: undefined }]);
    expect((await runtime.store.getRun(runId))?.status).toBe("running"); // run.started only
    expect((await runtime.jobQueue.countByStatus()).queued).toBe(0);
  });

  it("cron tick triggers all due schedules and returns immediately (no run_jobs)", async () => {
    const runtime = await createTestRuntime();
    const triggered: RootDispatchJob[] = [];
    (runtime as { dispatcher: TaskDispatcher }).dispatcher = recordingRenderDispatcher(triggered);
    const wf = workflow(async () => "ok");
    bindWorkflow(wf, "cron-wf", runtime);
    const workflows = new Map<string, WorkflowDefinition>([["cron-wf", wf]]);
    const app = createGatewayApp({ runtime, workflows, disableAuth: true });

    // Create a schedule due now.
    const mkRes = await app.request("/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "cron-wf", cronExpression: "* * * * *", input: { a: 1 } }),
    });
    expect(mkRes.status).toBe(201);

    const tick = await app.request("/admin/schedules/tick", { method: "POST" });
    expect(tick.status).toBe(200);
    const result = (await tick.json()) as { fired: Array<{ runId: string }> };
    expect(result.fired).toHaveLength(1);

    // The fired run is triggered (run.started), not executed by the tick; no queue.
    expect(triggered).toHaveLength(1);
    expect((await runtime.jobQueue.countByStatus()).queued).toBe(0);
    expect((await runtime.store.getRun(result.fired[0].runId))?.status).toBe("running");
  });

  it("resume fail-fast (E6): re-triggering an input-paused workflow root when the host is down marks it failed", async () => {
    const runtime = await createTestRuntime();
    const wf = workflow(async () => "done");
    bindWorkflow(wf, "wf", runtime);
    // Stand in for a down workflows host on the *resume* path: dispatchRoot throws.
    (runtime as { dispatcher: TaskDispatcher }).dispatcher = {
      dispatch: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 } }),
      dispatchRoot: async () => { throw new Error("ECONNREFUSED 127.0.0.1:8120"); },
    };

    // Seed an input-paused workflow root (as if a child requested user input).
    const runId = "wf-resume-failfast";
    await runtime.store.events.append(
      buildEventRecord(runId, { type: "run.started", input: {}, trigger: "api", spanKind: "workflow" }, { agentName: "wf", spanId: runId }),
    );
    await runtime.store.events.append(
      buildEventRecord(runId, { type: "input.requested", inputRequestId: "msg-1", kind: "message", prompt: "awaiting input" }, { agentName: "wf", spanId: runId }),
    );
    await runtime.store.events.append(
      buildEventRecord(runId, { type: "run.paused", reason: "input", pendingInputIds: ["msg-1"] }, { agentName: "wf", spanId: runId }),
    );
    expect((await runtime.store.getRun(runId))?.status).toBe("paused");

    const workflows = new Map<string, WorkflowDefinition>([["wf", wf]]);
    const app = createGatewayApp({ runtime, workflows, awaitResume: true, disableAuth: true });

    const res = await app.request(`/runs/${runId}/input`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "go" }),
    });
    expect(res.status).toBe(200);

    // Fail-fast on resume: the stranded root is now terminal (failed), not stuck.
    expect((await runtime.store.getRun(runId))?.status).toBe("failed");
    const types = (await runtime.store.events.read(runId)).map((e) => e.type);
    expect(types.filter((t) => t === "run.completed" || t === "run.failed" || t === "run.cancelled")).toEqual(["run.failed"]);
  });

  it("dev (InProcessDispatcher): POST /workflows/:name drives the workflow inline to completion", async () => {
    const runtime = await createTestRuntime(); // default in-process dispatcher
    let handlerRan = 0;
    const wf = workflow(async (ctx) => {
      await ctx.step("work", async () => { handlerRan += 1; return "ok"; });
      return "done";
    });
    bindWorkflow(wf, "wf", runtime);
    const workflows = new Map<string, WorkflowDefinition>([["wf", wf]]);
    const app = createGatewayApp({ runtime, workflows, disableAuth: true });

    const res = await app.request("/workflows/wf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { x: 1 }, trigger: "api" }),
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };

    expect(handlerRan).toBe(1);
    expect((await runtime.store.getRun(id))?.status).toBe("completed");
    expect((await runtime.jobQueue.countByStatus()).queued).toBe(0);
  });
});

describe("gateway queue mode — agent threads", () => {
  it("a thread's first message records the opening turn + enqueues an agent job", async () => {
    const model = mockModel((args) => {
      const lastUser = [...args.messages].reverse().find((m) => m.role === "user");
      const text = lastUser?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
      return { content: [{ type: "text", text: `reply:${text}` }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" } as never;
    });
    const runtime = await createTestRuntime({ executionMode: "queue", model });
    const def: AgentDefinition = {
      name: "concierge",
      model: { provider: "anthropic", model: "claude-haiku-4-5" },
      systemPrompt: "be helpful",
      tools: [],
    };
    runtime.agentDefinitions.set("concierge", def);
    const app = createGatewayApp({ runtime, defaultAgent: "concierge", disableAuth: true });

    const threadRes = await app.request("/threads", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const thread = (await threadRes.json()) as { id: string };

    const msgRes = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello there" }),
    });
    expect(msgRes.status).toBe(202);
    const { runId } = (await msgRes.json()) as { runId: string };

    // Opening turn recorded; agent not yet run; agent job queued.
    const types = (await runtime.store.events.read(runId)).map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("message.user");
    expect(types).not.toContain("message.assistant");
    expect((await runtime.jobQueue.countByStatus()).queued).toBe(1);

    // A runner drives the agent; the recorded user turn reaches the model.
    const worker = runWorker(runtime, { pollMs: 50 });
    await waitUntil(async () => (await runtime.store.getRun(runId))?.status === "completed");
    await worker.stop();

    expect((await runtime.store.getRun(runId))?.result).toBe("reply:hello there");
    const finalTypes = (await runtime.store.events.read(runId)).map((e) => e.type);
    expect(finalTypes.filter((t) => t === "run.started")).toHaveLength(1); // not duplicated by the drive
    expect(finalTypes.filter((t) => t === "message.user")).toHaveLength(1);
  });

  it("thread-busy guard (E4): a second message while the first turn is still active → 409", async () => {
    // Queue mode + no worker: the first turn stays active (run.started + queued
    // job, never drained), so the soft one-active-run-per-thread check trips.
    const runtime = await createTestRuntime({ executionMode: "queue" });
    runtime.agentDefinitions.set("concierge", {
      name: "concierge", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "be helpful", tools: [],
    });
    const app = createGatewayApp({ runtime, defaultAgent: "concierge", disableAuth: true });

    const thread = (await (await app.request("/threads", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };

    const first = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "one" }),
    });
    expect(first.status).toBe(202);
    const { runId } = (await first.json()) as { runId: string };

    const second = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "two" }),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string; runId: string };
    expect(body.error).toMatch(/busy/i);
    expect(body.runId).toBe(runId); // points at the in-flight run

    // Exactly one run was opened for the thread (the second never started one).
    expect((await runtime.store.listRuns({ threadId: thread.id })).length).toBe(1);
    expect((await runtime.jobQueue.countByStatus()).queued).toBe(1);
  });

  it("a single thread tail spans many turns without reconnecting (SSE across runs)", async () => {
    const model = mockModel((args) => {
      const users = args.messages.filter((m) => m.role === "user").length;
      return { content: [{ type: "text", text: `users=${users}` }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" } as never;
    });
    const runtime = await createTestRuntime({ executionMode: "queue", model });
    runtime.agentDefinitions.set("assistant", {
      name: "assistant", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "chat", tools: [], interactive: true,
    });
    const app = createGatewayApp({ runtime, defaultAgent: "assistant", disableAuth: true });
    const worker = runWorker(runtime, { pollMs: 50 });

    const thread = (await (await app.request("/threads", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };

    // One long-lived thread tail opened up front (as an SSE consumer would).
    const ac = new AbortController();
    const seenRunIds = new Set<string>();
    const collecting = (async () => {
      for await (const ev of runtime.store.events.tail({ threadId: thread.id }, ac.signal)) {
        seenRunIds.add(ev.runId);
      }
    })();

    const turn = async (content: string) => {
      const res = await app.request(`/threads/${thread.id}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }),
      });
      const { runId } = (await res.json()) as { runId: string };
      await waitUntil(async () => (await runtime.store.getRun(runId))?.status === "completed");
      return runId;
    };

    const run1 = await turn("hello");
    const run2 = await turn("again");

    await waitUntil(() => seenRunIds.has(run1) && seenRunIds.has(run2));
    ac.abort();
    await collecting.catch(() => {});
    await worker.stop();

    // Two distinct runs (new-run-per-turn), both observed on the SAME tail.
    expect(run1).not.toBe(run2);
    expect(seenRunIds.has(run1) && seenRunIds.has(run2)).toBe(true);
    // Memory carried across turns via the thread (users=1 then users=2).
    expect((await runtime.store.getRun(run2))?.result).toBe("users=2");
  });
});

describe("gateway queue mode — durable resume", () => {
  it("resolving an approval enqueues a durable resume job that drives the run to completion", async () => {
    process.env.RENDER_FACTORY_STRICT_APPROVAL = "1";
    try {
      let toolRuns = 0;
      const toolSources = new Map([
        ["deploy", defineTool({ name: "deploy", description: "ship it", inputSchema: {}, async invoke() { toolRuns += 1; return "deployed"; } })],
      ]);
      const responses = [
        { content: [{ type: "tool_use", id: "tc1", name: "deploy", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" },
        { content: [{ type: "text", text: "shipped" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
      ];
      let i = 0;
      const runtime = await createTestRuntime({
        executionMode: "queue",
        model: mockModel(() => responses[Math.min(i++, responses.length - 1)] as never),
        toolSources,
      });
      runtime.agentDefinitions.set("deployer", {
        name: "deployer",
        model: { provider: "anthropic", model: "claude-haiku-4-5" },
        systemPrompt: "deploy",
        tools: ["deploy"],
        permissions: { requireApproval: ["deploy"] },
      });
      const app = createGatewayApp({ runtime, defaultAgent: "deployer", awaitResume: true, disableAuth: true });

      // First turn: thread message → agent job → worker drives to the approval pause.
      const threadRes = await app.request("/threads", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const thread = (await threadRes.json()) as { id: string };
      const msgRes = await app.request(`/threads/${thread.id}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "ship it" }),
      });
      const { runId } = (await msgRes.json()) as { runId: string };

      const worker = runWorker(runtime, { pollMs: 50 });
      await waitUntil(async () => (await runtime.store.getRun(runId))?.status === "paused");
      expect(toolRuns).toBe(0);

      // Operator resolves the approval → enqueues a durable resume job.
      const approvalId = idempotencyKey(runId, "input:approval:tc1");
      const resolveRes = await app.request(`/inputs/${approvalId}/provide`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }),
      });
      expect(resolveRes.status).toBe(200);

      // The runner picks up the resume job and drives to completion.
      await waitUntil(async () => (await runtime.store.getRun(runId))?.status === "completed");
      await worker.stop();

      expect(toolRuns).toBe(1);
      expect((await runtime.store.getRun(runId))?.status).toBe("completed");
    } finally {
      delete process.env.RENDER_FACTORY_STRICT_APPROVAL;
    }
  });
});

describe("gateway queue observability + priority (Lane B)", () => {
  it("GET /admin/jobs reports chat-queue depth by status", async () => {
    const runtime = await createTestRuntime({ executionMode: "queue" });
    const app = createGatewayApp({ runtime, disableAuth: true });

    await runtime.jobQueue.enqueue({ runId: "a", kind: "agent" });
    await runtime.jobQueue.enqueue({ runId: "b", kind: "resume" });

    const res = await app.request("/admin/jobs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number>; backlog: number };
    expect(body.counts.queued).toBe(2);
    expect(body.backlog).toBe(2);
  });

  it("a resume preempts a fresh agent turn (priority: unblock waiting humans first)", async () => {
    const runtime = await createTestRuntime({ executionMode: "queue" });
    // Enqueue a fresh turn first, then a resume — claim order must favor the resume.
    await submitRootRun(runtime, { runId: "agent-turn", kind: "agent", driveInline: async () => {} });
    await submitRootRun(runtime, { runId: "resume-turn", kind: "resume", driveInline: async () => {} });

    const first = await runtime.jobQueue.claim("w1");
    expect(first?.runId).toBe("resume-turn");
  });
});

