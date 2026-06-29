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

describe("operator routes — approvals status filter", () => {
  it("GET /approvals?status= filters pending vs resolved history", async () => {
    const runtime = await createTestRuntime();
    await runtime.store.events.append(buildEventRecord("A", { type: "run.started" }));
    await runtime.store.events.append(buildEventRecord("A", { type: "approval.requested", approvalRequestId: "ap-A", toolName: "github", input: {} }));
    await runtime.store.events.append(buildEventRecord("B", { type: "run.started" }));
    await runtime.store.events.append(buildEventRecord("B", { type: "approval.requested", approvalRequestId: "ap-B", toolName: "deploy", input: {} }));
    await runtime.store.events.append(buildEventRecord("B", { type: "approval.resolved", approvalRequestId: "ap-B", approved: true, resolvedBy: "alice", reason: "lgtm" }));

    const app = createGatewayApp({ runtime, disableAuth: true });

    const pending = await (await app.request("/approvals")).json();
    expect(pending.approvals.map((a: { id: string }) => a.id)).toEqual(["ap-A"]);

    const approved = await (await app.request("/approvals?status=approved")).json();
    expect(approved.approvals).toHaveLength(1);
    expect(approved.approvals[0]).toMatchObject({ id: "ap-B", status: "approved", resolvedBy: "alice", reason: "lgtm" });

    const all = await (await app.request("/approvals?status=all")).json();
    expect(all.approvals).toHaveLength(2);
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
