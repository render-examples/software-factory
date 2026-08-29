import { defineChannel, md } from "@render-factory/sdk";
import { githubVerify, matchesRepoAllowlist } from "@render-factory/sdk";
import { normalizeGitHubEvent, type NormalizedGitHubEvent } from "../lib/github-events.js";
import specToPr from "../workflows/spec-to-pr/index.js";
import prReview from "../workflows/pr-review/index.js";
import prFix from "../workflows/pr-fix/index.js";

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

function ackDuplicate() {
  return {
    ack: new Response(JSON.stringify({ ok: true, duplicate: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  };
}

const github = defineChannel({
  id: "github",
  target: { workflow: specToPr, trigger: "github.issues" },
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
    let normalized: NormalizedGitHubEvent = normalizeGitHubEvent(event, JSON.parse(raw));

    if (normalized.kind !== "skip") {
      const repoAllowlist = process.env.RENDER_FACTORY_REPOS;
      if (repoAllowlist) {
        const patterns = repoAllowlist.split(",").map((s) => s.trim()).filter(Boolean);
        const repoFullName = `${normalized.repo.owner}/${normalized.repo.repo}`;
        if (!matchesRepoAllowlist(repoFullName, patterns)) {
          normalized = { kind: "skip", event: `repo ${repoFullName} not in allowlist` };
        }
      }
    }

    let target: { workflow: typeof specToPr | typeof prReview | typeof prFix; trigger: string };
    if (event === "pull_request") {
      target = { workflow: prReview, trigger: "github.pull_request" };
    } else if (event === "pull_request_review") {
      target = { workflow: prFix, trigger: "github.pull_request_review" };
    } else {
      target = { workflow: specToPr, trigger: `github.${event}` };
    }
    const conversationId =
      normalized.kind === "issue" ? `issue-${normalized.issue.number}`
        : normalized.kind === "pull" ? `pull-${normalized.pull.number}`
          : "unknown";
    return { conversationId, input: normalized, target };
  },
});

export default github;
