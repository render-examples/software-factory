import { Hono } from "hono";
import type { WorkflowDefinition, Channel } from "@render-agents/sdk";
import { checkWebhookAuth } from "../verify.js";

// Canonical Channel type lives in `@render-agents/sdk`; re-exported so importers
// of `./routes/channels.js` can grab it here too.
export type { Channel };

/** Rebuild a body-readable Request from buffered bytes (the raw body is read once
 *  for signature verification, which locks the original stream). */
function rebuildRequest(url: string, headers: Headers, body: string): Request {
  return new Request(url, { method: "POST", headers, body });
}

/**
 * Channel routes — the single inbound message surface (supersedes webhooks +
 * connectors). Each discovered channel mounts at `POST /channels/:id`.
 *
 * These routes are public (a third party can't present the operator API key), so
 * the channel's declarative `verify` policy IS the authentication. The gateway
 * enforces it here — before parse or dispatch — and is fail-closed: a channel
 * with no `verify` is rejected in production (see `checkWebhookAuth`).
 * Verification runs over the exact raw body bytes.
 */
export function channelRoutes(deps: {
  channels: Map<string, Channel>;
  workflows: Map<string, WorkflowDefinition>;
  /**
   * Handle an inbound message on a channel conversation (agent-target channels):
   * resolve/create the conversation's thread, satisfy a pending HITL input or
   * start a new turn, and return the HTTP result. Omitted on gateways without the
   * chat lane, in which case agent targets 501.
   */
  handleChannelMessage?: (
    agentName: string,
    input: unknown,
    binding: { channel: string; conversationId: string; user?: string },
  ) => Promise<{ runId: string; threadId: string; status: 200 | 202 | 409; body: Record<string, unknown> }>;
  /**
   * Deliver a completed run's reply — or a pending input prompt — inline (set only
   * in `inline` mode, where the run is terminal/paused by the time the route
   * returns). Omitted in `queue` mode; the worker's delivery producer handles it.
   */
  deliver?: (runId: string) => Promise<void>;
}) {
  const app = new Hono();
  const { channels, workflows, handleChannelMessage, deliver } = deps;

  // Best-effort inline delivery: a delivery failure must not fail the inbound ack
  // (the run already ran); the worker path is the one with real retries.
  const runDeliver = async (runId: string): Promise<void> => {
    if (!deliver) return;
    try {
      await deliver(runId);
    } catch (err) {
      console.error(`channel delivery failed for run ${runId}:`, err);
    }
  };

  app.post("/channels/:id", async (c) => {
    const id = c.req.param("id");
    const channel = channels.get(id);
    if (!channel) {
      return c.json({ error: `Channel "${id}" not found` }, 404);
    }

    // Read the raw body once (verification needs the exact bytes; this locks the
    // original request stream, so downstream reads use rebuilt Requests).
    const rawBody = await c.req.raw.text();
    const headers = c.req.raw.headers;
    const url = c.req.raw.url;

    const auth = checkWebhookAuth(channel.verify, `channel "${id}"`, { rawBody, headers });
    if (!auth.ok) {
      return c.json({ error: auth.reason }, auth.status);
    }

    // `match` may be async (platforms that route on the body, e.g. Slack).
    const matched = await channel.match(rebuildRequest(url, headers, rawBody));
    if (!matched) {
      return c.json({ error: "Channel did not match" }, 400);
    }
    // A provider handshake (e.g. Slack `url_verification`) answers inline without
    // starting a run.
    if ("ack" in matched) {
      return matched.ack;
    }

    const event = await channel.parse(rebuildRequest(url, headers, rawBody));
    const target = event.target ?? channel.target;

    if ("workflow" in target) {
      const workflow = workflows.get(target.workflow);
      if (!workflow) {
        return c.json({ error: `Target workflow "${target.workflow}" not found` }, 404);
      }
      // Stamp the channel binding so the run records its originating surface (for
      // outbound delivery) and the (channel, conversationId) mapping folds.
      const run = await workflow.dispatch(event.input, target.trigger ?? `channel.${id}`, {
        channel: id,
        externalConversationId: event.conversationId,
      });
      await runDeliver(run.id);
      return c.json({ runId: run.id, channel: id, workflow: target.workflow }, 202);
    }

    // Agent-target channels bind to a thread keyed by (channel, conversationId),
    // so a re-entrant inbound message continues the same conversation — satisfying
    // a pending HITL input, or starting a new turn (multi-turn memory via the
    // thread transcript).
    if (!handleChannelMessage) {
      return c.json({ error: "agent-target channels require a chat-enabled gateway" }, 501);
    }
    const res = await handleChannelMessage(target.agent, event.input, {
      channel: id,
      conversationId: event.conversationId,
      user: event.user,
    });
    // Inline: deliver the reply (on completion) or the input prompt (on pause) now.
    // Idempotent + best-effort; a no-op in queue mode (the producer handles it).
    await runDeliver(res.runId);
    return c.json(res.body, res.status);
  });

  return app;
}
