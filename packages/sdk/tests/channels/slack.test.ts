import { describe, it, expect } from "vitest";
import { slackChannel } from "../../src/channels/slack.js";
import type { ChannelDeliverContext } from "../../src/channel.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Build a POST Request carrying a JSON Slack envelope. */
function reqOf(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://x/channels/slack", { method: "POST", headers, body: JSON.stringify(body) });
}

/** A slack channel whose outbound `fetch` is captured (no network). */
function makeChannel(overrides: Parameters<typeof slackChannel>[0] = {}) {
  const calls: Array<{ url: string; auth?: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const channel = slackChannel({ fetchImpl, ...overrides });
  return { channel, calls };
}

const deliverCtx = (over: Partial<ChannelDeliverContext> & Pick<ChannelDeliverContext, "conversationId" | "message">): ChannelDeliverContext => ({
  env: (n) => (n === "SLACK_BOT_TOKEN" ? "xoxb-1" : undefined),
  logger: silentLogger,
  ...over,
});

describe("slackChannel — defaults", () => {
  it("defaults the target to the conversational assistant agent + slack verify", () => {
    const ch = slackChannel();
    expect(ch.target).toEqual({ agent: "assistant" });
    expect(ch.verify).toMatchObject({ scheme: "slack", signingSecretEnv: "SLACK_SIGNING_SECRET" });
  });

  it("honors an explicit workflow target + custom secret envs", () => {
    const ch = slackChannel({ target: { workflow: "triage" }, signingSecretEnv: "S", botTokenEnv: "B" });
    expect(ch.target).toEqual({ workflow: "triage" });
    expect(ch.verify).toMatchObject({ scheme: "slack", signingSecretEnv: "S" });
  });
});

describe("slackChannel — match (routing)", () => {
  it("answers the url_verification handshake with the challenge, no run", async () => {
    const { channel } = makeChannel();
    const res = await channel.match(reqOf({ type: "url_verification", challenge: "c-123" }));
    expect(res).not.toBeNull();
    expect(res).toHaveProperty("ack");
    const ack = (res as { ack: Response }).ack;
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ challenge: "c-123" });
  });

  it("accepts an app_mention event", async () => {
    const { channel } = makeChannel();
    const res = await channel.match(reqOf({ type: "event_callback", event: { type: "app_mention", channel: "C1", user: "U1", text: "<@U0> hi", ts: "1.1" } }));
    expect(res).toEqual({ event: "app_mention" });
  });

  it("accepts a threaded message reply and a DM, but not a bare channel message", async () => {
    const { channel } = makeChannel();
    const threaded = await channel.match(reqOf({ type: "event_callback", event: { type: "message", channel: "C1", ts: "2.2", thread_ts: "1.1", text: "more" } }));
    expect(threaded).toEqual({ event: "message" });

    const dm = await channel.match(reqOf({ type: "event_callback", event: { type: "message", channel: "D9", channel_type: "im", ts: "3.3", text: "hey" } }));
    expect(dm).toEqual({ event: "message" });

    // A non-threaded channel message isn't addressed to us → acked, not acted on.
    const bare = await channel.match(reqOf({ type: "event_callback", event: { type: "message", channel: "C1", ts: "4.4", text: "chatter" } }));
    expect(bare).toHaveProperty("ack");
  });

  it("loop-guards our own (and any bot's) posts", async () => {
    const { channel } = makeChannel();
    const res = await channel.match(reqOf({ type: "event_callback", event: { type: "message", bot_id: "B1", channel: "C1", thread_ts: "1.1", text: "reply" } }));
    expect(res).toHaveProperty("ack");
    expect(res).not.toHaveProperty("event");
  });

  it("ignores message subtypes (edits/joins/bot_message)", async () => {
    const { channel } = makeChannel();
    const res = await channel.match(reqOf({ type: "event_callback", event: { type: "message", subtype: "message_changed", channel: "C1", thread_ts: "1.1" } }));
    expect(res).toHaveProperty("ack");
  });

  it("de-dupes Slack retries (acks without reprocessing)", async () => {
    const { channel } = makeChannel();
    const res = await channel.match(reqOf({ type: "event_callback", event: { type: "app_mention", channel: "C1", ts: "1.1", text: "hi" } }, { "x-slack-retry-num": "2" }));
    expect(res).toHaveProperty("ack");
    expect(res).not.toHaveProperty("event");
  });

  it("returns null for a non-JSON body (400 at the route)", async () => {
    const { channel } = makeChannel();
    const res = await channel.match(new Request("http://x", { method: "POST", body: "not json{" }));
    expect(res).toBeNull();
  });
});

describe("slackChannel — parse (normalization)", () => {
  it("keys a channel mention on channel:ts and strips the leading mention", async () => {
    const { channel } = makeChannel();
    const ev = await channel.parse(reqOf({ type: "event_callback", event: { type: "app_mention", channel: "C1", user: "U1", text: "<@U0BOT> deploy please", ts: "111.1" } }));
    expect(ev).toEqual({ conversationId: "C1:111.1", input: "deploy please", user: "U1" });
  });

  it("keys a threaded reply on the root thread_ts (so it resolves to the same conversation)", async () => {
    const { channel } = makeChannel();
    const ev = await channel.parse(reqOf({ type: "event_callback", event: { type: "message", channel: "C1", user: "U1", text: "follow up", ts: "222.2", thread_ts: "111.1" } }));
    expect(ev.conversationId).toBe("C1:111.1");
    expect(ev.input).toBe("follow up");
  });

  it("keys a DM on the DM channel id (flat, one conversation)", async () => {
    const { channel } = makeChannel();
    const ev = await channel.parse(reqOf({ type: "event_callback", event: { type: "message", channel: "D9", channel_type: "im", user: "U1", text: "hey", ts: "3.3" } }));
    expect(ev.conversationId).toBe("D9");
  });

  it("can leave the mention intact when stripMention is false", async () => {
    const { channel } = makeChannel({ stripMention: false });
    const ev = await channel.parse(reqOf({ type: "event_callback", event: { type: "app_mention", channel: "C1", text: "<@U0> hi", ts: "1.1" } }));
    expect(ev.input).toBe("<@U0> hi");
  });
});

describe("slackChannel — deliver (chat.postMessage)", () => {
  it("posts a threaded reply with the bot token", async () => {
    const { channel, calls } = makeChannel();
    await channel.deliver!(deliverCtx({ conversationId: "C1:111.1", message: { text: "the reply" } }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("chat.postMessage");
    expect(calls[0].auth).toBe("Bearer xoxb-1");
    expect(calls[0].body).toEqual({ channel: "C1", thread_ts: "111.1", text: "the reply" });
  });

  it("posts flat (no thread_ts) for a DM conversation", async () => {
    const { channel, calls } = makeChannel();
    await channel.deliver!(deliverCtx({ conversationId: "D9", message: { text: "hi" } }));
    expect(calls[0].body).toEqual({ channel: "D9", text: "hi" });
  });

  it("falls back to placeholder text when the reply is empty", async () => {
    const { channel, calls } = makeChannel();
    await channel.deliver!(deliverCtx({ conversationId: "D9", message: { text: "   " } }));
    expect(calls[0].body.text).toBe("(no content)");
  });

  it("throws (→ requeue) when the bot token env is unset", async () => {
    const { channel } = makeChannel();
    await expect(channel.deliver!(deliverCtx({ conversationId: "C1:1.1", message: { text: "x" }, env: () => undefined }))).rejects.toThrow(/SLACK_BOT_TOKEN/);
  });

  it("throws (→ requeue) when Slack returns ok:false", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 })) as unknown as typeof globalThis.fetch;
    const channel = slackChannel({ fetchImpl });
    await expect(channel.deliver!(deliverCtx({ conversationId: "C1:1.1", message: { text: "x" } }))).rejects.toThrow(/channel_not_found/);
  });
});
