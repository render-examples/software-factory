import { describe, it, expect } from "vitest";
import { buildEventRecord } from "@render-agents/store";
import { createTestRuntime } from "@render-agents/sdk/testing";
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
    process.env.RENDER_AGENTS_API_KEY = "sekret";
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

    delete process.env.RENDER_AGENTS_API_KEY;
  });

  it("still accepts the bearer header for API/curl callers", async () => {
    process.env.RENDER_AGENTS_API_KEY = "sekret";
    const runtime = await createTestRuntime();
    const app = createGatewayApp({ runtime });
    const who = await app.request("/whoami", { headers: { authorization: "Bearer sekret" } });
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({ role: "operator" });
    delete process.env.RENDER_AGENTS_API_KEY;
  });
});
