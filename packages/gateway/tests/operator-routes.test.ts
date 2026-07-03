import { describe, it, expect } from "vitest";
import { buildEventRecord } from "@render-agents/store";
import { createTestRuntime } from "@render-agents/sdk/testing";
import { createGatewayApp } from "../src/index.js";

describe("operator routes — per-run event log", () => {
  it("GET /runs/:id/events returns the ordered raw log", async () => {
    const runtime = await createTestRuntime();
    const runId = "ev-run-1";
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.started", trigger: "api" }));
    await runtime.store.events.append(
      buildEventRecord(runId, { type: "llm.call", model: "m", usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0.01, stopReason: "end_turn", latencyMs: 5 }),
    );
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.completed", result: "ok" }));

    const app = createGatewayApp({ runtime, disableAuth: true });
    const res = await app.request(`/runs/${runId}/events`);
    expect(res.status).toBe(200);
    const { events } = await res.json();
    expect(events.map((e: { type: string }) => e.type)).toEqual(["run.started", "llm.call", "run.completed"]);
    expect(events[0].seq).toBe(1);

    expect((await app.request("/runs/missing/events")).status).toBe(404);
  });
});

describe("operator routes — cross-run children", () => {
  it("GET /runs hides children by default; /runs/:id/children lists them", async () => {
    const runtime = await createTestRuntime();
    // Parent workflow run with a tool span.
    await runtime.store.events.append(buildEventRecord("p", { type: "run.started", trigger: "api", spanKind: "workflow" }, { agentName: "wf", spanId: "p" }));
    await runtime.store.events.append(buildEventRecord("p", { type: "tool.called", toolCallId: "t1", name: "spawn", input: {} }, { agentName: "wf", spanId: "tool-1", parentSpanId: "p" }));
    // Fan-out child (parentSpanId === parent run id) and subagent child (tool span).
    await runtime.store.events.append(buildEventRecord("childWF", { type: "run.started" }, { agentName: "security", spanId: "childWF", parentSpanId: "p" }));
    await runtime.store.events.append(buildEventRecord("childSub", { type: "run.started" }, { agentName: "helper", spanId: "childSub", parentSpanId: "tool-1" }));

    const app = createGatewayApp({ runtime, disableAuth: true });

    // Default list shows only the root.
    const rootsList = await (await app.request("/runs")).json();
    expect(rootsList.runs.map((r: { id: string }) => r.id)).toEqual(["p"]);

    // Opt in to children with roots=false.
    const allList = await (await app.request("/runs?roots=false")).json();
    expect(allList.runs.map((r: { id: string }) => r.id).sort()).toEqual(["childSub", "childWF", "p"]);

    // The children endpoint returns both children of the parent.
    const kids = await (await app.request("/runs/p/children")).json();
    expect(kids.runs.map((r: { id: string }) => r.id)).toEqual(["childWF", "childSub"]);

    // Unknown parent → 404.
    expect((await app.request("/runs/missing/children")).status).toBe(404);
  });
});

describe("operator routes — inputs status filter", () => {
  it("GET /inputs?status= filters pending vs resolved history", async () => {
    const runtime = await createTestRuntime();
    await runtime.store.events.append(buildEventRecord("A", { type: "run.started" }));
    await runtime.store.events.append(buildEventRecord("A", { type: "input.requested", inputRequestId: "ap-A", kind: "approval", toolName: "github", input: {} }));
    await runtime.store.events.append(buildEventRecord("B", { type: "run.started" }));
    await runtime.store.events.append(buildEventRecord("B", { type: "input.requested", inputRequestId: "ap-B", kind: "approval", toolName: "deploy", input: {} }));
    await runtime.store.events.append(buildEventRecord("B", { type: "input.provided", inputRequestId: "ap-B", kind: "approval", approved: true, providedBy: "alice", reason: "lgtm" }));

    const app = createGatewayApp({ runtime, disableAuth: true });

    const pending = await (await app.request("/inputs")).json();
    expect(pending.inputs.map((a: { id: string }) => a.id)).toEqual(["ap-A"]);

    const approved = await (await app.request("/inputs?status=approved")).json();
    expect(approved.inputs).toHaveLength(1);
    expect(approved.inputs[0]).toMatchObject({ id: "ap-B", status: "approved", providedBy: "alice", reason: "lgtm" });

    const all = await (await app.request("/inputs?status=all")).json();
    expect(all.inputs).toHaveLength(2);
  });
});

describe("operator routes — token-delta streaming (D13)", () => {
  it("GET /runs/:id/stream merges transient text.delta frames from the DeltaBus", async () => {
    const runtime = await createTestRuntime();
    const runId = "stream-delta-run";
    // A live (non-terminal) run so the stream stays open for the live tail.
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.started", trigger: "api" }));

    const app = createGatewayApp({ runtime, disableAuth: true });
    const ac = new AbortController();
    const res = await app.request(`/runs/${runId}/stream`, { signal: ac.signal });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    // Let the merged tail + delta subscription attach before publishing.
    await new Promise((r) => setTimeout(r, 50));
    await runtime.deltaBus.publish({ runId, agentName: "tester", seq: 1, text: "streamed token" });

    let seen = "";
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !seen.includes("text.delta")) {
      const chunk = await Promise.race([
        reader.read().then((r) => new TextDecoder().decode(r.value ?? new Uint8Array())),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000)),
      ]);
      seen += chunk;
    }
    expect(seen).toContain("text.delta");
    expect(seen).toContain("streamed token");
    // Transient frames carry no SSE id (they must not move the reconnect cursor):
    // isolate the delta frame and assert it has no `id:` line at all (not merely
    // that it isn't `id: undefined`).
    const deltaFrame = seen.split("\n\n").find((f) => f.includes("text.delta"));
    expect(deltaFrame).toBeDefined();
    expect(deltaFrame!).not.toMatch(/(^|\n)id:/);

    ac.abort();
    await reader.cancel().catch(() => {});
  });
});

describe("operator routes — thread stream catch-up (BUG-07)", () => {
  it("replays a thread's durable history on connect with composite runId:seq ids", async () => {
    const runtime = await createTestRuntime();
    const threadId = "t-catchup";
    // Two runs in the same thread; each run's seq restarts at 1, so only a
    // composite id disambiguates them across the thread stream.
    await runtime.store.events.append(buildEventRecord("run-a", { type: "run.started", trigger: "thread_message", threadId }, { spanId: "run-a" }));
    await runtime.store.events.append(buildEventRecord("run-a", { type: "run.completed", result: "hi" }, { spanId: "run-a" }));
    await runtime.store.events.append(buildEventRecord("run-b", { type: "run.started", trigger: "thread_message", threadId }, { spanId: "run-b" }));

    const app = createGatewayApp({ runtime, disableAuth: true });
    const ac = new AbortController();
    const res = await app.request(`/threads/${threadId}/stream`, { signal: ac.signal });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    let seen = "";
    const deadline = Date.now() + 2000;
    // Wait until the catch-up replay has emitted the second run's opener.
    while (Date.now() < deadline && !seen.includes("run-b:1")) {
      const chunk = await Promise.race([
        reader.read().then((r) => new TextDecoder().decode(r.value ?? new Uint8Array())),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000)),
      ]).catch(() => "");
      seen += chunk;
    }

    // Both runs replayed, each with a composite id keyed on its own run. The
    // composite ids only appear in the SSE `id:` line (the data payload carries
    // no runId), so matching the substrings is spacing-agnostic.
    expect(seen).toContain("run-a:1");
    expect(seen).toContain("run-b:1");
    expect(seen).toContain("run.started");
    expect(seen).toContain("run.completed");

    ac.abort();
    await reader.cancel().catch(() => {});
  });
});

describe("operator routes — global event stream", () => {
  it("GET /events/stream tails events across all runs", async () => {
    const runtime = await createTestRuntime();
    const app = createGatewayApp({ runtime, disableAuth: true });

    const ac = new AbortController();
    const res = await app.request("/events/stream", { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    // Let the tail subscription attach before appending.
    await new Promise((r) => setTimeout(r, 50));
    await runtime.store.events.append(buildEventRecord("stream-run", { type: "run.started", trigger: "api" }));

    const chunk = await Promise.race([
      reader.read().then((r) => new TextDecoder().decode(r.value ?? new Uint8Array())),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000)),
    ]);
    expect(chunk).toContain("run.started");
    expect(chunk).toContain("stream-run");

    ac.abort();
    await reader.cancel().catch(() => {});
  });
});
