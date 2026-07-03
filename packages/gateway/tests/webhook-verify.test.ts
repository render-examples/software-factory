import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  createMemoryStore,
  MemoryCancelStore,
  MemoryJobQueue,
  MemoryDeltaBus,
  type RunStore,
} from "@render-agents/store";
import {
  createGatewayApp,
  verifyWebhookRequest,
  webhookVerifyRequired,
  type GatewayOptions,
} from "../src/index.js";
import {
  githubVerify,
  hmacVerify,
  slackVerify,
  stripeVerify,
  standardWebhooksVerify,
  type Channel,
  type WorkflowDefinition,
} from "@render-agents/sdk";

// --- helpers -------------------------------------------------------------

/** Minimal AgentRuntime for route tests (routes only touch `store`). */
function makeTestRuntime(store: RunStore): GatewayOptions["runtime"] {
  return {
    store,
    tracer: { onStart: () => {}, onEnd: () => {} },
    model: { complete: async () => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" }) },
    runners: { get: () => { throw new Error("no runner"); }, has: () => false },
    hooks: { get: () => { throw new Error("no hook"); }, has: () => false, ids: () => [] },
    contextManager: { prepare: async (m) => m },
    cancelStore: new MemoryCancelStore(),
    jobQueue: new MemoryJobQueue(),
    deltaBus: new MemoryDeltaBus(),
    executionMode: "inline",
    agentDefinitions: new Map(),
    workflows: new Map(),
    toolSources: new Map(),
    channels: new Map(),
    threadStore: store as unknown as GatewayOptions["runtime"]["threadStore"],
    oauthStore: store as unknown as GatewayOptions["runtime"]["oauthStore"],
    scheduleStore: store as unknown as GatewayOptions["runtime"]["scheduleStore"],
    oauthRefreshers: new Map(),
  };
}

/** A workflows map with one workflow that records dispatch calls. */
function recordingWorkflows() {
  const dispatched: Array<{ input: unknown; trigger?: string }> = [];
  const wf = {
    dispatch: async (input: unknown, trigger?: string) => {
      dispatched.push({ input, trigger });
      return { id: "run-1" } as Awaited<ReturnType<WorkflowDefinition["dispatch"]>>;
    },
  } as unknown as WorkflowDefinition;
  return { workflows: new Map([["code-review", wf]]), dispatched };
}

async function buildApp(opts: {
  channels?: Map<string, Channel>;
  workflows: Map<string, WorkflowDefinition>;
}) {
  const store = createMemoryStore();
  await store.init();
  return createGatewayApp({
    runtime: makeTestRuntime(store),
    disableAuth: true,
    channels: opts.channels,
    workflows: opts.workflows,
  });
}

function githubSignature(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

const ENV_KEYS = [
  "GITHUB_WEBHOOK_SECRET",
  "SLACK_SIGNING_SECRET",
  "STRIPE_WEBHOOK_SECRET",
  "WEBHOOK_SECRET",
  "NODE_ENV",
  "RENDER_AGENTS_REQUIRE_WEBHOOK_VERIFY",
];
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});
function setEnv(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

// --- unit: verifyWebhookRequest per scheme -------------------------------

describe("verifyWebhookRequest", () => {
  const body = JSON.stringify({ hello: "world" });
  const env = (map: Record<string, string>) => (n: string) => map[n];

  it("github: accepts a valid signature, rejects a bad one", () => {
    const secret = "gh-secret";
    const ctx = {
      rawBody: body,
      headers: new Headers({ "x-hub-signature-256": githubSignature(secret, body) }),
      env: env({ GITHUB_WEBHOOK_SECRET: secret }),
    };
    expect(verifyWebhookRequest(githubVerify(), ctx)).toEqual({ ok: true });

    const bad = { ...ctx, headers: new Headers({ "x-hub-signature-256": "sha256=deadbeef" }) };
    expect(verifyWebhookRequest(githubVerify(), bad).ok).toBe(false);
  });

  it("github: rejects when the secret env is unset or the header is missing", () => {
    expect(verifyWebhookRequest(githubVerify(), { rawBody: body, headers: new Headers(), env: env({}) }).ok).toBe(false);
    const withSecret = { rawBody: body, headers: new Headers(), env: env({ GITHUB_WEBHOOK_SECRET: "s" }) };
    const res = verifyWebhookRequest(githubVerify(), withSecret);
    expect(res.ok).toBe(false);
  });

  it("hmac (generic): verifies a base64 sha1 signature with no prefix", () => {
    const secret = "abc";
    const sig = createHmac("sha1", secret).update(body, "utf8").digest("base64");
    const v = hmacVerify({ header: "x-sig", secretEnv: "MY_SECRET", algorithm: "sha1", encoding: "base64" });
    const ctx = { rawBody: body, headers: new Headers({ "x-sig": sig }), env: env({ MY_SECRET: secret }) };
    expect(verifyWebhookRequest(v, ctx)).toEqual({ ok: true });
  });

  it("slack: accepts a fresh signature, rejects a stale timestamp (replay)", () => {
    const secret = "slack-secret";
    const now = Date.now();
    const ts = Math.floor(now / 1000).toString();
    const sig = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`, "utf8").digest("hex");
    const headers = new Headers({ "x-slack-signature": sig, "x-slack-request-timestamp": ts });
    const ctx = { rawBody: body, headers, now, env: env({ SLACK_SIGNING_SECRET: secret }) };
    expect(verifyWebhookRequest(slackVerify(), ctx)).toEqual({ ok: true });

    const staleTs = (Math.floor(now / 1000) - 10_000).toString();
    const staleSig = "v0=" + createHmac("sha256", secret).update(`v0:${staleTs}:${body}`, "utf8").digest("hex");
    const stale = {
      rawBody: body,
      headers: new Headers({ "x-slack-signature": staleSig, "x-slack-request-timestamp": staleTs }),
      now,
      env: env({ SLACK_SIGNING_SECRET: secret }),
    };
    expect(verifyWebhookRequest(slackVerify(), stale).ok).toBe(false);
  });

  it("stripe: parses t=/v1= and verifies over `{t}.{body}`", () => {
    const secret = "stripe-secret";
    const now = Date.now();
    const t = Math.floor(now / 1000).toString();
    const sig = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
    const headers = new Headers({ "stripe-signature": `t=${t},v1=${sig}` });
    const ctx = { rawBody: body, headers, now, env: env({ STRIPE_WEBHOOK_SECRET: secret }) };
    expect(verifyWebhookRequest(stripeVerify(), ctx)).toEqual({ ok: true });

    const bad = { ...ctx, headers: new Headers({ "stripe-signature": `t=${t},v1=nope` }) };
    expect(verifyWebhookRequest(stripeVerify(), bad).ok).toBe(false);
  });

  it("standard-webhooks: verifies base64 sig over `{id}.{ts}.{body}` with a whsec_ key", () => {
    const keyBytes = Buffer.from("0123456789abcdef0123456789abcdef");
    const secret = "whsec_" + keyBytes.toString("base64");
    const now = Date.now();
    const ts = Math.floor(now / 1000).toString();
    const id = "msg_123";
    const sig = createHmac("sha256", keyBytes).update(`${id}.${ts}.${body}`, "utf8").digest("base64");
    const headers = new Headers({
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": `v1,${sig}`,
    });
    const ctx = { rawBody: body, headers, now, env: env({ WEBHOOK_SECRET: secret }) };
    expect(verifyWebhookRequest(standardWebhooksVerify(), ctx)).toEqual({ ok: true });
  });

  it('"none" always passes', () => {
    expect(verifyWebhookRequest("none", { rawBody: body, headers: new Headers() })).toEqual({ ok: true });
    expect(verifyWebhookRequest({ scheme: "none" }, { rawBody: body, headers: new Headers() })).toEqual({ ok: true });
  });
});

// --- unit: fail-closed policy --------------------------------------------

describe("webhookVerifyRequired", () => {
  it("defaults on in production, off otherwise", () => {
    expect(webhookVerifyRequired({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
    expect(webhookVerifyRequired({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
    expect(webhookVerifyRequired({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("honors an explicit override either way", () => {
    expect(webhookVerifyRequired({ RENDER_AGENTS_REQUIRE_WEBHOOK_VERIFY: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(
      webhookVerifyRequired({ NODE_ENV: "production", RENDER_AGENTS_REQUIRE_WEBHOOK_VERIFY: "0" } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

// --- route-level: channels enforce verification before dispatch ----------

describe("channel routes — verification enforcement", () => {
  const body = JSON.stringify({ pull_request: { diff_url: "https://x" } });

  function ghChannel(verify: Channel["verify"]): Channel {
    return {
      target: { workflow: "code-review", trigger: "github.pull_request" },
      verify,
      match: () => ({ event: "pull_request" }),
      parse: async (req) => ({ conversationId: "pr-1", input: { raw: await req.text() } }),
    };
  }

  async function post(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) {
    return app.request("/channels/github", { method: "POST", headers, body });
  }

  it("dispatches (202) on a valid GitHub signature", async () => {
    setEnv("GITHUB_WEBHOOK_SECRET", "s3cr3t");
    const { workflows, dispatched } = recordingWorkflows();
    const app = await buildApp({ channels: new Map([["github", ghChannel(githubVerify())]]), workflows });
    const res = await post(app, { "x-hub-signature-256": githubSignature("s3cr3t", body) });
    expect(res.status).toBe(202);
    expect(dispatched).toHaveLength(1);
  });

  it("rejects (401) a bad signature and never dispatches", async () => {
    setEnv("GITHUB_WEBHOOK_SECRET", "s3cr3t");
    const { workflows, dispatched } = recordingWorkflows();
    const app = await buildApp({ channels: new Map([["github", ghChannel(githubVerify())]]), workflows });
    const res = await post(app, { "x-hub-signature-256": "sha256=deadbeef" });
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it("rejects (401) when the configured secret env is missing", async () => {
    setEnv("GITHUB_WEBHOOK_SECRET", undefined);
    const { workflows, dispatched } = recordingWorkflows();
    const app = await buildApp({ channels: new Map([["github", ghChannel(githubVerify())]]), workflows });
    const res = await post(app, { "x-hub-signature-256": githubSignature("s3cr3t", body) });
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it('allows (202) an unsigned request when verify is "none"', async () => {
    const { workflows, dispatched } = recordingWorkflows();
    const app = await buildApp({ channels: new Map([["github", ghChannel("none")]]), workflows });
    const res = await post(app, {});
    expect(res.status).toBe(202);
    expect(dispatched).toHaveLength(1);
  });

  it("is fail-closed: no `verify` → 401 in production", async () => {
    setEnv("NODE_ENV", "production");
    const { workflows, dispatched } = recordingWorkflows();
    const app = await buildApp({ channels: new Map([["github", ghChannel(undefined)]]), workflows });
    const res = await post(app, {});
    expect(res.status).toBe(401);
    expect(dispatched).toHaveLength(0);
  });

  it("no `verify` → allowed in dev (with a warning)", async () => {
    setEnv("NODE_ENV", "development");
    const { workflows, dispatched } = recordingWorkflows();
    const app = await buildApp({ channels: new Map([["github", ghChannel(undefined)]]), workflows });
    const res = await post(app, {});
    expect(res.status).toBe(202);
    expect(dispatched).toHaveLength(1);
  });
});
