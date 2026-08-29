import { defineChannel } from "@render-factory/sdk";
import { slackVerify } from "@render-factory/sdk";
import type { ChannelDeliverContext } from "@render-factory/sdk";
import { assistant } from "../agents/index.js";

interface SlackEnvelope {
  type?: string;
  challenge?: string;
  event?: SlackEvent;
}

interface SlackEvent {
  type?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

function ack200(): Response {
  return new Response(null, { status: 200 });
}

function shouldHandle(ev: SlackEvent | undefined): ev is SlackEvent & { type: string } {
  if (!ev || typeof ev !== "object" || !ev.type) return false;
  if (ev.bot_id) return false;
  if (ev.subtype) return false;
  if (ev.type === "app_mention") return true;
  if (ev.type === "message") return ev.channel_type === "im" || typeof ev.thread_ts === "string";
  return false;
}

function splitConversation(conversationId: string): { channel: string; threadTs?: string } {
  const idx = conversationId.indexOf(":");
  if (idx === -1) return { channel: conversationId };
  return { channel: conversationId.slice(0, idx), threadTs: conversationId.slice(idx + 1) };
}

export default defineChannel({
  id: "slack",
  target: { agent: assistant },
  verify: slackVerify(),

  async match(req: Request) {
    let body: SlackEnvelope;
    try {
      body = (await req.json()) as SlackEnvelope;
    } catch {
      return null;
    }

    if (body.type === "url_verification" && typeof body.challenge === "string") {
      return {
        ack: new Response(JSON.stringify({ challenge: body.challenge }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      };
    }

    if (req.headers.get("x-slack-retry-num")) return { ack: ack200() };

    if (body.type === "event_callback" && shouldHandle(body.event)) {
      return { event: body.event.type };
    }

    return { ack: ack200() };
  },

  async parse(req: Request) {
    const body = (await req.json()) as SlackEnvelope;
    const ev = body.event ?? {};
    const channel = ev.channel ?? "";
    const isDM = ev.channel_type === "im" || channel.startsWith("D");
    const conversationId = isDM ? channel : `${channel}:${ev.thread_ts ?? ev.ts ?? ""}`;
    let text = ev.text ?? "";
    text = text.replace(/^\s*<@[^>]+>\s*/, "");
    return { conversationId, input: text, user: ev.user };
  },

  async deliver(ctx: ChannelDeliverContext) {
    const token = ctx.env("SLACK_BOT_TOKEN");
    if (!token) {
      throw new Error("slack channel deliver: SLACK_BOT_TOKEN is not set");
    }
    const { channel, threadTs } = splitConversation(ctx.conversationId);
    const text = ctx.message.text?.trim() || "(no content)";
    const payload = threadTs ? { channel, thread_ts: threadTs, text } : { channel, text };

    const res = await fetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      throw new Error(`slack deliver: chat.postMessage failed (${data.error ?? `http ${res.status}`})`);
    }
    ctx.logger.info(`slack: delivered to ${channel}${threadTs ? ` (thread ${threadTs})` : ""}`);
  },
});
