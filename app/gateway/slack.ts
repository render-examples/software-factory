/**
 * Slack webhook handler. Verifies signatures, parses events, dispatches assistant task.
 */
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendMessage, getOrCreateThread } from "../../sdk/threads.js";

interface SlackEnvelope {
  type?: string;
  challenge?: string;
  event?: {
    type?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  };
}

function verifySlackSignature(rawBody: string, headers: Headers): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const computed = "v0=" + createHmac("sha256", secret).update(base).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function postSlackMessage(channel: string, text: string, threadTs?: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  const payload: Record<string, string> = { channel, text };
  if (threadTs) payload.thread_ts = threadTs;
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function slackHandler(): Hono {
  const app = new Hono();

  app.post("/slack", async (c) => {
    const rawBody = await c.req.text();

    if (!verifySlackSignature(rawBody, c.req.raw.headers)) {
      return c.json({ error: "invalid signature" }, 401);
    }

    const body = JSON.parse(rawBody) as SlackEnvelope;

    if (body.type === "url_verification" && body.challenge) {
      return c.json({ challenge: body.challenge });
    }

    if (c.req.raw.headers.get("x-slack-retry-num")) {
      return c.json({ ok: true });
    }

    const ev = body.event;
    if (!ev?.type || ev.bot_id || ev.subtype) return c.json({ ok: true });

    const shouldHandle =
      ev.type === "app_mention" ||
      (ev.type === "message" && (ev.channel_type === "im" || typeof ev.thread_ts === "string"));
    if (!shouldHandle) return c.json({ ok: true });

    const channel = ev.channel ?? "";
    const isDM = ev.channel_type === "im" || channel.startsWith("D");
    const threadTs = ev.thread_ts ?? ev.ts ?? "";
    const threadId = isDM ? channel : `${channel}:${threadTs}`;
    let text = ev.text ?? "";
    text = text.replace(/^\s*<@[^>]+>\s*/, "");

    await getOrCreateThread(threadId, { channel, slackUser: ev.user ?? "" });
    await appendMessage(threadId, "user", text);

    const slug = process.env.RENDER_WORKFLOW_SLUG;
    if (slug) {
      try {
        const { Render } = await import("@renderinc/sdk");
        const client = new Render();
        await client.workflows.startTask(`${slug}/assistant`, [
          { message: text, threadId },
        ]);
      } catch (err) {
        console.error("Failed to dispatch assistant task:", err);
      }
    }

    return c.json({ ok: true });
  });

  return app;
}
