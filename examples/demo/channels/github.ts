import type { Channel, ChannelMatch } from "@render-agents/sdk";
import { githubVerify } from "@render-agents/sdk";
import { normalizeGitHubEvent } from "../src/lib/github-events.js";

// GitHub redelivers a webhook (manual "Redeliver" or automatic retry on
// timeout/5xx) using the SAME `x-github-delivery` id — unlike Slack, there's
// no separate "this is a retry" header to key off of. Without de-duping,
// a redelivered `issues`/`pull_request` event starts a second run (a second
// PR, duplicate comments, etc.). Track recently seen delivery ids and ack a
// duplicate without reprocessing (mirrors the Slack reference channel's
// retry de-dupe in `match`). In-memory + TTL-bounded: sufficient for a
// single-process demo; a multi-replica deployment needs a shared/durable
// dedupe store instead.
const SEEN_DELIVERY_TTL_MS = 10 * 60 * 1000;
const seenDeliveries = new Map<string, number>();

function isDuplicateDelivery(deliveryId: string | null): boolean {
  if (!deliveryId) return false;
  const now = Date.now();
  for (const [id, ts] of seenDeliveries) {
    if (now - ts > SEEN_DELIVERY_TTL_MS) seenDeliveries.delete(id);
  }
  if (seenDeliveries.has(deliveryId)) return true;
  seenDeliveries.set(deliveryId, now);
  return false;
}

function ackDuplicate(): ChannelMatch {
  return {
    ack: new Response(JSON.stringify({ ok: true, duplicate: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  };
}

// Auto-discovered at POST /channels/github. A channel is the single inbound/
// outbound message surface. Inbound channels are NOT behind the operator API key
// (third parties can't send it) — the signature IS the authentication. The
// declarative `verify` makes the gateway check the GitHub HMAC signature (over
// the raw body, using GITHUB_WEBHOOK_SECRET) BEFORE this channel runs, so
// `match`/`parse` can trust the request.
//
// Inbound-only (no `deliver`): each event fans out to a workflow by type, and the
// workflows own their GitHub side effects (comments, PRs, reviews) via ctx.step.
//   issues / issue_comment  -> issue-to-pr
//   pull_request            -> pr-review
// Sub-action routing (opened vs. created vs. synchronize) happens inside the
// workflows, since `match` only sees headers, not the body.
const channel: Channel = {
  // Default target; `parse` sets the per-event target + trigger below.
  target: { workflow: "issue-to-pr" },
  verify: githubVerify(),

  match(req: Request) {
    const event = req.headers.get("x-github-event");
    if (event === "issues" || event === "issue_comment" || event === "pull_request") {
      if (isDuplicateDelivery(req.headers.get("x-github-delivery"))) {
        return ackDuplicate();
      }
      return { event };
    }
    return null;
  },

  async parse(req: Request) {
    const raw = await req.text();
    const event = req.headers.get("x-github-event") ?? "";
    const normalized = normalizeGitHubEvent(event, JSON.parse(raw));
    const target =
      event === "pull_request"
        ? { workflow: "pr-review", trigger: "github.pull_request" }
        : { workflow: "issue-to-pr", trigger: `github.${event}` };
    // conversationId keys the external conversation (issue/PR number) — the
    // resume/outbound-delivery binding lands with channels' conversation support.
    const conversationId =
      normalized.kind === "issue" ? `issue-${normalized.issue.number}`
        : normalized.kind === "pull" ? `pull-${normalized.pull.number}`
          : "unknown";
    return { conversationId, input: normalized, target };
  },
};

export default channel;
