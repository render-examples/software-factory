import { Hono } from "hono";
import type { WorkflowDefinition, Channel } from "@render-agents/sdk";
import { checkWebhookAuth } from "../verify.js";

// Re-exported from @render-agents/sdk so importers of this module can grab it too.
export type { Channel };

const MAX_CHANNEL_BODY_BYTES_ENV = "RENDER_AGENTS_MAX_CHANNEL_BODY_BYTES";
const DEFAULT_MAX_CHANNEL_BODY_BYTES = 1_000_000;
const REQUIRE_CHANNEL_CONTENT_TYPE_ENV = "RENDER_AGENTS_REQUIRE_CHANNEL_CONTENT_TYPE";

function maxChannelBodyBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_CHANNEL_BODY_BYTES_ENV];
  if (!raw) return DEFAULT_MAX_CHANNEL_BODY_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CHANNEL_BODY_BYTES;
  return Math.floor(n);
}

function requireChannelContentType(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[REQUIRE_CHANNEL_CONTENT_TYPE_ENV];
  if (!raw) return false;
  const lowered = raw.toLowerCase();
  return lowered !== "0" && lowered !== "false";
}

function hasSupportedContentType(contentType: string): boolean {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType === "application/json" ||
    mediaType.endsWith("+json") ||
    mediaType === "application/x-www-form-urlencoded" ||
    mediaType === "multipart/form-data" ||
    mediaType === "text/plain"
  );
}

/** Rebuild a body-readable Request from buffered bytes (the raw body is read once
 *  for signature verification, which locks the original stream). */
function rebuildRequest(url: string, headers: Headers, body: string): Request {
  return new Request(url, { method: "POST", headers, body });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readRawBodyLimited(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; rawBody: string } | { ok: false; status: 413 | 400; error: string }> {
  const declared = req.headers.get("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      return { ok: false, status: 413, error: `payload too large (max ${maxBytes} bytes)` };
    }
  }
  if (!req.body) return { ok: true, rawBody: "" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel("payload too large"); } catch { /* no-op */ }
        return { ok: false, status: 413, error: `payload too large (max ${maxBytes} bytes)` };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "failed to read request body" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, rawBody: new TextDecoder().decode(bytes) };
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
  const maxBodyBytes = maxChannelBodyBytesFromEnv();
  const strictContentType = requireChannelContentType();

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

    // Verification needs exact bytes and locks the stream; downstream reads use rebuilt Requests.
    const body = await readRawBodyLimited(c.req.raw, maxBodyBytes);
    if (!body.ok) {
      return c.json({ error: body.error }, body.status);
    }
    const rawBody = body.rawBody;
    const headers = c.req.raw.headers;
    const url = c.req.raw.url;
    if (strictContentType && rawBody.length > 0) {
      const contentType = headers.get("content-type");
      if (!contentType) {
        return c.json({ error: "missing content-type for non-empty channel request body" }, 415);
      }
      if (!hasSupportedContentType(contentType)) {
        return c.json({ error: `unsupported content-type "${contentType}" for channel request body` }, 415);
      }
    }

    const auth = checkWebhookAuth(channel.verify, `channel "${id}"`, { rawBody, headers });
    if (!auth.ok) {
      return c.json({ error: auth.reason }, auth.status);
    }

    // `match` may be async (platforms that route on the body, e.g. Slack). A
    // signature can verify over a body that's otherwise malformed (garbage,
    // truncated, wrong shape) — `match`/`parse` are third-party-authored and may
    // throw (e.g. `JSON.parse` on a non-JSON payload), which must surface as a
    // client error (bad payload) rather than an unhandled 500.
    let matched;
    try {
      matched = await channel.match(rebuildRequest(url, headers, rawBody));
    } catch (err) {
      return c.json({ error: `Channel "${id}" failed to match request: ${errorMessage(err)}` }, 400);
    }
    if (!matched) {
      return c.json({ error: "Channel did not match" }, 400);
    }
    // Provider handshake (e.g. Slack url_verification) answers inline without starting a run.
    if ("ack" in matched) {
      return matched.ack;
    }

    let event;
    try {
      event = await channel.parse(rebuildRequest(url, headers, rawBody));
    } catch (err) {
      return c.json({ error: `Channel "${id}" failed to parse request: ${errorMessage(err)}` }, 400);
    }
    const target = event.target ?? channel.target;

    if ("workflow" in target) {
      const workflow = workflows.get(target.workflow);
      if (!workflow) {
        return c.json({ error: `Target workflow "${target.workflow}" not found` }, 404);
      }
      // Stamp the binding so the run records its origin for outbound delivery.
      const run = await workflow.dispatch(event.input, target.trigger ?? `channel.${id}`, {
        channel: id,
        externalConversationId: event.conversationId,
      });
      await runDeliver(run.id);
      return c.json({ runId: run.id, channel: id, workflow: target.workflow }, 202);
    }

    // Agent-target channels bind to a thread keyed by (channel, conversationId),
    // so a re-entrant message continues the conversation.
    if (!handleChannelMessage) {
      return c.json({ error: "agent-target channels require a chat-enabled gateway" }, 501);
    }
    const res = await handleChannelMessage(target.agent, event.input, {
      channel: id,
      conversationId: event.conversationId,
      user: event.user,
    });
    // Idempotent + best-effort; a no-op in queue mode (the producer handles it).
    await runDeliver(res.runId);
    return c.json(res.body, res.status);
  });

  return app;
}
