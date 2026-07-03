import { describe, it, expect } from "vitest";
import { createMemoryStore, type ScheduleStore } from "@render-agents/store";
import type { WorkflowDefinition } from "@render-agents/sdk";
import { createTestRuntime } from "@render-agents/sdk/testing";
import { createGatewayApp } from "../src/index.js";
import { reconcileDueSchedules } from "../src/routes/schedules.js";

/** A stub workflow that records dispatches and returns a fake run record. */
function stubWorkflow(name: string, calls: Array<{ input: unknown; trigger?: string }>): WorkflowDefinition {
  let n = 0;
  return {
    name,
    options: {},
    async dispatch(input: unknown, trigger?: string) {
      calls.push({ input, trigger });
      return { id: `${name}-run-${n++}`, workflow: name, status: "completed", totalCostUsd: 0, startedAt: new Date().toISOString() } as never;
    },
    async drive() { /* unused by the schedule reconciler */ },
  };
}

const baseRec = (id: string, over = {}) => ({
  id, workflow: "code-review", cronExpression: "*/5 * * * *", enabled: true,
  createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z", ...over,
});

describe("reconcileDueSchedules", () => {
  it("fires a due schedule, stamps lastRunId/lastRunAt, and is idempotent within the minute", async () => {
    const store: ScheduleStore = createMemoryStore();
    const calls: Array<{ input: unknown; trigger?: string }> = [];
    const workflows = new Map([["code-review", stubWorkflow("code-review", calls)]]);
    await store.createSchedule(baseRec("s1", { cronExpression: "30 4 * * *", input: { diff: "x" } }));

    const now = new Date("2026-06-29T04:30:10Z");
    const first = await reconcileDueSchedules({ scheduleStore: store, workflows }, now);
    expect(first.fired).toHaveLength(1);
    expect(first.fired[0]).toMatchObject({ scheduleId: "s1", workflow: "code-review" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: { diff: "x" }, trigger: "cron" });

    const stamped = await store.getSchedule("s1");
    expect(stamped?.lastRunId).toBe("code-review-run-0");
    expect(stamped?.lastRunAt).toBe(now.toISOString());

    // A retried/overlapping tick in the same minute must not re-fire.
    const second = await reconcileDueSchedules({ scheduleStore: store, workflows }, new Date("2026-06-29T04:30:55Z"));
    expect(second.fired).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("skips disabled schedules and records unknown-workflow skips", async () => {
    const store: ScheduleStore = createMemoryStore();
    const calls: Array<{ input: unknown; trigger?: string }> = [];
    const workflows = new Map([["code-review", stubWorkflow("code-review", calls)]]);
    await store.createSchedule(baseRec("disabled", { cronExpression: "* * * * *", enabled: false }));
    await store.createSchedule(baseRec("ghost", { cronExpression: "* * * * *", workflow: "missing" }));

    const res = await reconcileDueSchedules({ scheduleStore: store, workflows }, new Date("2026-06-29T04:30:00Z"));
    expect(res.fired).toHaveLength(0);
    expect(res.skipped).toEqual([{ scheduleId: "ghost", reason: 'workflow "missing" not found' }]);
    expect(calls).toHaveLength(0);
  });
});

describe("gateway schedule routes (CRUD)", () => {
  async function appWithWorkflow() {
    const runtime = await createTestRuntime();
    const workflows = new Map([["code-review", stubWorkflow("code-review", [])]]);
    return createGatewayApp({ runtime, workflows, disableAuth: true });
  }

  it("creates, lists, gets, patches, and deletes a schedule", async () => {
    const app = await appWithWorkflow();

    const createRes = await app.request("/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow: "code-review", cronExpression: "0 4 * * *", input: { diff: "d" } }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created).toMatchObject({ workflow: "code-review", cronExpression: "0 4 * * *", enabled: true });
    const id = created.id;

    const listRes = await app.request("/schedules");
    expect((await listRes.json()).schedules).toHaveLength(1);

    const getRes = await app.request(`/schedules/${id}`);
    expect((await getRes.json()).id).toBe(id);

    const patchRes = await app.request(`/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect((await patchRes.json()).enabled).toBe(false);

    const delRes = await app.request(`/schedules/${id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect((await (await app.request("/schedules")).json()).schedules).toHaveLength(0);
  });

  it("rejects an invalid cron and an unknown workflow", async () => {
    const app = await appWithWorkflow();
    const badCron = await app.request("/schedules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow: "code-review", cronExpression: "not a cron" }),
    });
    expect(badCron.status).toBe(400);

    const badWf = await app.request("/schedules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow: "nope", cronExpression: "* * * * *" }),
    });
    expect(badWf.status).toBe(400);
  });

  it("PATCH /schedules/:id rejects unsupported fields and invalid types", async () => {
    const app = await appWithWorkflow();
    const created = await (
      await app.request("/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: "code-review", cronExpression: "0 4 * * *" }),
      })
    ).json();

    const id = created.id as string;
    const unsupported = await app.request(`/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastRunAt: "2026-01-01T00:00:00.000Z" }),
    });
    expect(unsupported.status).toBe(400);

    const invalidType = await app.request(`/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "false" }),
    });
    expect(invalidType.status).toBe(400);

    const empty = await app.request(`/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });

  it("POST /admin/schedules/tick returns a reconcile result", async () => {
    const app = await appWithWorkflow();
    const res = await app.request("/admin/schedules/tick", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("checked");
    expect(body).toHaveProperty("fired");
  });
});
