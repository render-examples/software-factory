import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookAdapter } from "@render-agents/sdk";
import { normalizeGitHubEvent } from "../src/lib/github-events.js";

// Auto-discovered at POST /webhooks/github. `match` routes cheaply on the event
// header; `parse` verifies the HMAC signature before trusting the body, then
// normalizes it. Inbound webhooks are NOT behind the operator API key (third
// parties can't send it) — the signature IS the authentication. Set
// GITHUB_WEBHOOK_SECRET to the secret configured on the GitHub webhook.
//
// One adapter fans out to two workflows by event type:
//   issues / issue_comment  -> issue-to-pr
//   pull_request            -> pr-review
// Sub-action routing (opened vs. created vs. synchronize) happens inside the
// workflows, since `match` only sees headers, not the body.

function verifySignature(raw: string, provided: string | null): void {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is not set");
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(provided ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid GitHub webhook signature");
  }
}

const adapter: WebhookAdapter = {
  name: "github",

  match(req: Request) {
    const event = req.headers.get("x-github-event");
    if (event === "issues" || event === "issue_comment") {
      return { workflow: "issue-to-pr", trigger: `github.${event}` };
    }
    if (event === "pull_request") {
      return { workflow: "pr-review", trigger: "github.pull_request" };
    }
    return null;
  },

  async parse(req: Request) {
    const raw = await req.text();
    verifySignature(raw, req.headers.get("x-hub-signature-256"));
    const event = req.headers.get("x-github-event") ?? "";
    return normalizeGitHubEvent(event, JSON.parse(raw));
  },
};

export default adapter;
