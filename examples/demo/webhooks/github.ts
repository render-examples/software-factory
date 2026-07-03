import type { WebhookAdapter } from "@render-agents/sdk";
import { githubVerify } from "@render-agents/sdk";
import { normalizeGitHubEvent } from "../src/lib/github-events.js";

// Auto-discovered at POST /webhooks/github. Inbound webhooks are NOT behind the
// operator API key (third parties can't send it) — the signature IS the
// authentication. The declarative `verify` below makes the gateway check the
// GitHub HMAC signature (over the raw body, using GITHUB_WEBHOOK_SECRET) BEFORE
// this adapter runs, so `match`/`parse` can trust the request.
//
// One adapter fans out to two workflows by event type:
//   issues / issue_comment  -> issue-to-pr
//   pull_request            -> pr-review
// Sub-action routing (opened vs. created vs. synchronize) happens inside the
// workflows, since `match` only sees headers, not the body.

const adapter: WebhookAdapter = {
  name: "github",
  verify: githubVerify(),

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
    const event = req.headers.get("x-github-event") ?? "";
    return normalizeGitHubEvent(event, JSON.parse(raw));
  },
};

export default adapter;
