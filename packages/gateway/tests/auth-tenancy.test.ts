import { describe, it, expect } from "vitest";
import { buildEventRecord } from "@render-factory/store";
import { workflow, bindWorkflow, type WorkflowDefinition } from "@render-factory/sdk";
import { createTestRuntime } from "@render-factory/sdk/testing";
import { createGatewayApp } from "../src/index.js";
import type { AuthResolver } from "../src/auth.js";

/**
 * Test resolver: `x-op: 1` → operator (sees all); `x-user: <id>` → that end user
 * (scoped to their own data); otherwise unauthenticated.
 */
function testAuth(): AuthResolver {
  return async (req: Request) => {
    if (req.headers.get("x-op") === "1") return { userId: "op", role: "operator" };
    const u = req.headers.get("x-user");
    return u ? { userId: u, role: "user" } : null;
  };
}

async function seedRun(
  runtime: Awaited<ReturnType<typeof createTestRuntime>>,
  runId: string,
  userId: string,
): Promise<void> {
  await runtime.store.events.append(
    buildEventRecord(runId, { type: "run.started", trigger: "api", userId }, { spanId: runId }),
  );
  await runtime.store.events.append(buildEventRecord(runId, { type: "run.completed", result: "ok" }));
}

const U = (id: string) => ({ headers: { "x-user": id } });
const OP = { headers: { "x-op": "1" } };

/** JSON POST body with an auth header merged in. */
function jsonReq(auth: { headers: Record<string, string> }, body: unknown) {
  return { method: "POST", headers: { ...auth.headers, "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** A runtime + app with one registered workflow, for schedule/admin tests. */
async function appWithWorkflow() {
  const runtime = await createTestRuntime();
  const wf = workflow(async () => "ok");
  bindWorkflow(wf, "wf", runtime);
  const workflows = new Map<string, WorkflowDefinition>([["wf", wf]]);
  const app = createGatewayApp({ runtime, workflows, auth: testAuth(), serveUI: false });
  return { runtime, app };
}

describe("multi-tenancy — run ownership (CR-D1)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const runtime = await createTestRuntime();
    const app = createGatewayApp({ runtime, auth: testAuth(), serveUI: false });
    expect((await app.request("/runs")).status).toBe(401);
  });

  it("a user cannot read another user's run (404, not enumerable)", async () => {
    const runtime = await createTestRuntime();
    await seedRun(runtime, "r-alice", "alice");
    const app = createGatewayApp({ runtime, auth: testAuth(), serveUI: false });

    expect((await app.request("/runs/r-alice", U("alice"))).status).toBe(200);
    expect((await app.request("/runs/r-alice", U("bob"))).status).toBe(404);
    // Cancel + sub-resources are scoped too.
    expect((await app.request("/runs/r-alice/events", U("bob"))).status).toBe(404);
    expect((await app.request("/runs/r-alice/cancel", { method: "POST", ...U("bob") })).status).toBe(404);
  });

  it("scopes the run list to the caller; operators see all", async () => {
    const runtime = await createTestRuntime();
    await seedRun(runtime, "r-alice", "alice");
    await seedRun(runtime, "r-bob", "bob");
    const app = createGatewayApp({ runtime, auth: testAuth(), serveUI: false });

    const alice = await (await app.request("/runs", U("alice"))).json();
    expect(alice.runs.map((r: { id: string }) => r.id)).toEqual(["r-alice"]);

    const bob = await (await app.request("/runs", U("bob"))).json();
    expect(bob.runs.map((r: { id: string }) => r.id)).toEqual(["r-bob"]);

    const op = await (await app.request("/runs", OP)).json();
    expect(op.runs.map((r: { id: string }) => r.id).sort()).toEqual(["r-alice", "r-bob"]);
  });
});

describe("multi-tenancy — thread ownership (CR-D1)", () => {
  it("confines threads to their owner; operators see all", async () => {
    const runtime = await createTestRuntime();
    const app = createGatewayApp({ runtime, auth: testAuth(), serveUI: false });

    const created = await (
      await app.request("/threads", { method: "POST", ...U("alice"), body: "{}" })
    ).json();
    // The owner comes from auth, not the body.
    expect(created.userId).toBe("alice");

    // Owner reads it; a different user gets 404; operator can read it.
    expect((await app.request(`/threads/${created.id}`, U("alice"))).status).toBe(200);
    expect((await app.request(`/threads/${created.id}`, U("bob"))).status).toBe(404);
    expect((await app.request(`/threads/${created.id}`, OP)).status).toBe(200);

    // Listing is scoped.
    const bobList = await (await app.request("/threads", U("bob"))).json();
    expect(bobList.threads).toEqual([]);
    const aliceList = await (await app.request("/threads", U("alice"))).json();
    expect(aliceList.threads.map((t: { id: string }) => t.id)).toEqual([created.id]);
  });
});

describe("UI cookie session (CR-D1 / CR-19)", () => {
  it("login exchanges the key for a session; /whoami reflects it", async () => {
    process.env.RENDER_FACTORY_API_KEY = "sekret";
    const runtime = await createTestRuntime();
    // UI enabled (default) so /ui/login is mounted and the resolver accepts the cookie.
    const app = createGatewayApp({ runtime });

    // No session yet.
    expect((await app.request("/whoami")).status).toBe(401);

    // Wrong key rejected.
    const bad = await app.request("/ui/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "nope" }),
    });
    expect(bad.status).toBe(401);

    // Correct key issues a signed cookie.
    const ok = await app.request("/ui/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "sekret" }),
    });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie");
    expect(setCookie).toContain("render_agents_session=");
    expect(setCookie?.toLowerCase()).toContain("httponly");

    // The cookie authenticates a follow-up request (no bearer needed).
    const cookie = setCookie!.split(";")[0];
    const who = await app.request("/whoami", { headers: { cookie } });
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({ userId: "operator", role: "operator" });

    delete process.env.RENDER_FACTORY_API_KEY;
  });

  it("still accepts the bearer header for API/curl callers", async () => {
    process.env.RENDER_FACTORY_API_KEY = "sekret";
    const runtime = await createTestRuntime();
    const app = createGatewayApp({ runtime });
    const who = await app.request("/whoami", { headers: { authorization: "Bearer sekret" } });
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({ role: "operator" });
    delete process.env.RENDER_FACTORY_API_KEY;
  });
});

describe("multi-tenancy — schedule ownership (CR-D1)", () => {
  it("confines schedules to their owner; operators see all; owner comes from auth", async () => {
    const { app } = await appWithWorkflow();
    const mk = (u: string) => app.request("/schedules", jsonReq(U(u), { workflow: "wf", cronExpression: "* * * * *" }));

    const aSched = await (await mk("alice")).json();
    expect(aSched.userId).toBe("alice"); // stamped from auth, not the body

    // A different user can't read, patch, or delete it (404, not enumerable).
    expect((await app.request(`/schedules/${aSched.id}`, U("bob"))).status).toBe(404);
    const bobPatch = await app.request(`/schedules/${aSched.id}`, {
      method: "PATCH",
      headers: { ...U("bob").headers, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(bobPatch.status).toBe(404);
    expect((await app.request(`/schedules/${aSched.id}`, { method: "DELETE", ...U("bob") })).status).toBe(404);

    // Owner + operator can read it.
    expect((await app.request(`/schedules/${aSched.id}`, U("alice"))).status).toBe(200);
    expect((await app.request(`/schedules/${aSched.id}`, OP)).status).toBe(200);

    // Listing is scoped: bob sees only his, alice only hers, operator sees all.
    await mk("bob");
    const bobList = await (await app.request("/schedules", U("bob"))).json();
    expect(bobList.schedules.every((s: { userId: string }) => s.userId === "bob")).toBe(true);
    const aliceList = await (await app.request("/schedules", U("alice"))).json();
    expect(aliceList.schedules.map((s: { id: string }) => s.id)).toEqual([aSched.id]);
    const opList = await (await app.request("/schedules", OP)).json();
    expect(opList.schedules.length).toBe(2);
  });
});

describe("multi-tenancy — /admin/* is operator-only (CR-D1)", () => {
  it("rejects end users with 403 and admits operators", async () => {
    const { app } = await appWithWorkflow();
    const adminRoutes: Array<["GET" | "POST", string]> = [
      ["POST", "/admin/retention"],
      ["POST", "/admin/runs/reap"],
      ["GET", "/admin/jobs"],
      ["POST", "/admin/schedules/tick"],
    ];
    for (const [method, path] of adminRoutes) {
      expect((await app.request(path, { method, ...U("alice") })).status).toBe(403);
    }
    // Operators pass through to the handler.
    expect((await app.request("/admin/jobs", OP)).status).toBe(200);
    expect((await app.request("/admin/schedules/tick", { method: "POST", ...OP })).status).toBe(200);
    expect((await app.request("/admin/retention", { method: "POST", ...OP })).status).toBe(200);
    expect((await app.request("/admin/runs/reap", { method: "POST", ...OP })).status).toBe(200);
  });
});

describe("multi-tenancy — thread stream ownership (CR-D1)", () => {
  it("denies a user tailing a foreign thread or one with no owner row (404)", async () => {
    const runtime = await createTestRuntime();
    const app = createGatewayApp({ runtime, auth: testAuth(), serveUI: false });
    const created = await (await app.request("/threads", { method: "POST", ...U("alice"), body: "{}" })).json();

    // Foreign thread → 404 (check happens before streaming starts).
    expect((await app.request(`/threads/${created.id}/stream`, U("bob"))).status).toBe(404);
    // A thread id with no metadata row → non-operator denied (closes the no-row bypass).
    expect((await app.request("/threads/ghost-thread/stream", U("bob"))).status).toBe(404);
  });
});

describe("multi-tenancy — per-user SSE stream token (CR-D1)", () => {
  it("mints a token that streams the owner's run but not another tenant's", async () => {
    const runtime = await createTestRuntime();
    await seedRun(runtime, "r-alice", "alice");
    await seedRun(runtime, "r-bob", "bob");
    const app = createGatewayApp({ runtime, auth: testAuth(), serveUI: false });

    // Alice mints a stream token by authenticating normally.
    const { token } = await (await app.request("/auth/stream-token", { method: "POST", ...U("alice") })).json();
    const tok = encodeURIComponent(token);

    // Her terminal run streams (and closes) with the token in the query.
    expect((await app.request(`/runs/r-alice/stream?token=${tok}`)).status).toBe(200);
    // The same token cannot read another tenant's run (canAccess still enforced).
    expect((await app.request(`/runs/r-bob/stream?token=${tok}`)).status).toBe(404);
    // A tampered token is rejected outright.
    expect((await app.request(`/runs/r-alice/stream?token=${tok}TAMPER`)).status).toBe(401);
  });
});
