// Slack — the reference platform channel (P4). One module owning Slack's inbound
// (Events API) and outbound (`chat.postMessage`) sides, built entirely on the
// generic `Channel` contract: no engine internals, just verify + match + parse +
// deliver. Drop a `channels/slack.ts` that default-exports `slackChannel({...})`
// and the gateway mounts it at `POST /channels/slack`.
//
// Inbound: `verify: slackVerify()` (the gateway checks the `v0=` HMAC over the raw
// body before this runs). `match` answers Slack's one-time `url_verification`
// handshake, filters to the events we act on (guarding against our own bot's posts
// to avoid loops), and de-dupes Slack's at-least-once retries. `parse` normalizes
// an event into a turn, keying the conversation so re-entrant messages continue
// the same thread.
//
// Outbound: `deliver` posts the reply back with `chat.postMessage`, threading it
// under the originating message (channels) or sending it flat (DMs). This is the
// "minimal formatting mapping" — plain text in/out; Block Kit is deferred.

import type { Channel, ChannelDeliverContext, ChannelInboundEvent, ChannelMatch, ChannelTarget } from "../channel.js";
import { slackVerify } from "../webhook-verify.js";

/** The subset of `fetch` `deliver` uses — overridable in tests. */
type FetchLike = typeof globalThis.fetch;

export interface SlackChannelOptions {
  /**
   * What inbound events drive. Defaults to `{ agent: "assistant" }` — the common
   * case (a Slack bot backed by a conversational agent). Point at a workflow for a
   * fire-and-forget pipeline instead.
   */
  target?: ChannelTarget;
  /** Env var holding the Slack signing secret (inbound verification). Default `SLACK_SIGNING_SECRET`. */
  signingSecretEnv?: string;
  /** Env var holding the bot token (`xoxb-…`) used for `chat.postMessage`. Default `SLACK_BOT_TOKEN`. */
  botTokenEnv?: string;
  /** Replay window (seconds) for inbound signature timestamps. Default 300. */
  toleranceSec?: number;
  /** Strip a leading `<@BOT>` mention from `app_mention` text. Default `true`. */
  stripMention?: boolean;
  /** Override the HTTP client (tests/advanced). Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Override the `chat.postMessage` endpoint (tests/advanced). */
  postMessageUrl?: string;
}

/** Slack Events API envelope (only the fields this channel reads). */
interface SlackEnvelope {
  type?: string; // "url_verification" | "event_callback"
  challenge?: string;
  event?: SlackEvent;
}
interface SlackEvent {
  type?: string; // "app_mention" | "message"
  channel?: string;
  channel_type?: string; // "im" for DMs
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string; // present on posts made by a bot (incl. ours) — loop guard
  subtype?: string; // edits/joins/bot_message/etc. — not a plain user message
}

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

/** A fast 200 with no body — Slack's expected ack for a delivery we accept-but-ignore. */
function ack200(): Response {
  return new Response(null, { status: 200 });
}

/** Whether an inbound event is a plain user message we should act on (not a bot echo). */
function shouldHandle(ev: SlackEvent | undefined): ev is SlackEvent & { type: string } {
  if (!ev || typeof ev !== "object" || !ev.type) return false;
  if (ev.bot_id) return false; // our own (or any bot's) post — never loop on it
  if (ev.subtype) return false; // message edits, joins, bot_message, etc.
  if (ev.type === "app_mention") return true; // explicit invocation
  // Threaded follow-ups (continue a conversation) and DMs (unambiguously for us).
  if (ev.type === "message") return ev.channel_type === "im" || typeof ev.thread_ts === "string";
  return false;
}

/**
 * Decode a conversationId back into a `chat.postMessage` target. A channel thread
 * is `"<channel>:<thread_ts>"` (reply threaded); a DM is just `"<channel>"`
 * (reply flat). Split on the first `:` only — Slack ids never contain one.
 */
function splitConversation(conversationId: string): { channel: string; threadTs?: string } {
  const idx = conversationId.indexOf(":");
  if (idx === -1) return { channel: conversationId };
  return { channel: conversationId.slice(0, idx), threadTs: conversationId.slice(idx + 1) };
}

/**
 * Build the Slack reference channel. Inbound Events API + outbound
 * `chat.postMessage`, with conversation mapping on `channel:thread_ts` (channels)
 * or the DM id (DMs), so a threaded/DM follow-up continues the same agent thread.
 */
export function slackChannel(opts: SlackChannelOptions = {}): Channel {
  const target = opts.target ?? { agent: "assistant" };
  const botTokenEnv = opts.botTokenEnv ?? "SLACK_BOT_TOKEN";
  const stripMention = opts.stripMention ?? true;
  const postMessageUrl = opts.postMessageUrl ?? SLACK_POST_MESSAGE_URL;
  const doFetch: FetchLike = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args));

  return {
    target,
    verify: slackVerify({ signingSecretEnv: opts.signingSecretEnv, toleranceSec: opts.toleranceSec }),

    async match(req: Request): Promise<ChannelMatch> {
      let body: SlackEnvelope;
      try {
        body = (await req.json()) as SlackEnvelope;
      } catch {
        return null; // not JSON → not a Slack delivery
      }

      // 1. One-time endpoint handshake: echo the challenge, no run.
      if (body.type === "url_verification" && typeof body.challenge === "string") {
        return {
          ack: new Response(JSON.stringify({ challenge: body.challenge }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        };
      }

      // 2. De-dupe Slack's at-least-once retries (it resends if we're slow): ack
      //    fast without reprocessing. Run creation is idempotent per conversation
      //    anyway, but this avoids the needless 409/duplicate.
      if (req.headers.get("x-slack-retry-num")) return { ack: ack200() };

      // 3. A real event we act on → proceed to parse/dispatch.
      if (body.type === "event_callback" && shouldHandle(body.event)) {
        return { event: body.event.type };
      }

      // 4. A valid Slack delivery we don't act on (bot echo, unsupported subtype):
      //    ack 200 so Slack considers it handled and stops retrying.
      return { ack: ack200() };
    },

    async parse(req: Request): Promise<ChannelInboundEvent> {
      const body = (await req.json()) as SlackEnvelope;
      const ev = body.event ?? {};
      const channel = ev.channel ?? "";
      const isDM = ev.channel_type === "im" || channel.startsWith("D");
      // DMs are one flat conversation (the DM channel); channels thread under the
      // root message so a threaded reply resolves back to the same conversation.
      const conversationId = isDM ? channel : `${channel}:${ev.thread_ts ?? ev.ts ?? ""}`;
      let text = ev.text ?? "";
      if (stripMention) text = text.replace(/^\s*<@[^>]+>\s*/, "");
      return { conversationId, input: text, user: ev.user };
    },

    async deliver(ctx: ChannelDeliverContext): Promise<void> {
      const token = ctx.env(botTokenEnv);
      if (!token) {
        throw new Error(`slackChannel.deliver: bot token env "${botTokenEnv}" is not set`);
      }
      const { channel, threadTs } = splitConversation(ctx.conversationId);
      // chat.postMessage rejects empty text; fall back so a text-less turn still
      // acknowledges rather than erroring.
      const text = ctx.message.text?.trim() || "(no content)";
      const payload = threadTs ? { channel, thread_ts: threadTs, text } : { channel, text };

      const res = await doFetch(postMessageUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });
      // Slack returns HTTP 200 with `{ ok: false, error }` on logical failures, so
      // check both. Throwing requeues the deliver job (at-least-once → the reaper/
      // backoff + dead-letter budget bound retries of a permanent failure).
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(`slackChannel.deliver: chat.postMessage failed (${data.error ?? `http ${res.status}`})`);
      }
      ctx.logger.info(`slack: delivered to ${channel}${threadTs ? ` (thread ${threadTs})` : ""}`);
    },
  };
}
