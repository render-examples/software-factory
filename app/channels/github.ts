import type { Channel, ChannelMatch } from "@render-factory/sdk";
import { githubVerify } from "@render-factory/sdk";
import { normalizeGitHubEvent } from "../lib/github-events.js";

// Best-effort hot-path dedup: avoids unnecessary DB roundtrips for rapid GitHub
// retries. DURABLE dedup is handled by the framework's one-active-run DB
// constraint — same conversationId → same thread → unique index rejects a
// second concurrent run.started. If this process restarts and the Map is empty,
// a retry that slips through is caught at the DB level (returns 409).
const SEEN_DELIVERY_TTL_MS = 10 * 60 * 1000;
const seenDeliveries = new Map<string, number>();

function isDuplicateDelivery(deliveryId: string | null): boolean {
  if (!deliveryId) return false;
  const now = Date.now();
  if (seenDeliveries.size > 500) {
    for (const [id, ts] of seenDeliveries) {
      if (now - ts > SEEN_DELIVERY_TTL_MS) seenDeliveries.delete(id);
    }
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

const channel: Channel = {
  target: { workflow: "spec-to-pr" },
  verify: githubVerify(),

  match(req: Request) {
    const event = req.headers.get("x-github-event");
    if (event === "issues" || event === "issue_comment" || event === "pull_request" || event === "pull_request_review") {
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
    let target: { workflow: string; trigger: string };
    if (event === "pull_request") {
      target = { workflow: "pr-review", trigger: "github.pull_request" };
    } else if (event === "pull_request_review") {
      target = { workflow: "pr-fix", trigger: "github.pull_request_review" };
    } else {
      target = { workflow: "spec-to-pr", trigger: `github.${event}` };
    }
    const conversationId =
      normalized.kind === "issue" ? `issue-${normalized.issue.number}`
        : normalized.kind === "pull" ? `pull-${normalized.pull.number}`
          : "unknown";
    return { conversationId, input: normalized, target };
  },
};

export default channel;
