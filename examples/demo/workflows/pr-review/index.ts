import { workflow } from "@render-agents/sdk";
import { githubFromEnv, type PullFile, type ReviewComment } from "../../src/lib/github.js";
import type { NormalizedGitHubEvent } from "../../src/lib/github-events.js";

// PR reviewer (trigger: pull_request). Fans out to four specialist reviewers as
// isolated Render Workflows tasks (.task()), then a judge makes the final
// structured decision and the workflow submits a real GitHub review (APPROVE /
// REQUEST_CHANGES) in a deterministic step.
//
// Each .task() dispatches an `agent@<plan>` task on the Workflows service, so the
// four reviewers run concurrently in their own scale-to-zero containers — the
// fan-out this demo showcases. (They only need the diff text; no shared FS.)

const REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
const MAX_DIFF_CHARS = 60_000;

interface Verdict {
  decision: "approve" | "request_changes";
  summary: string;
  inline_comments?: ReviewComment[];
}

function renderDiff(files: PullFile[]): string {
  let out = "";
  for (const f of files) {
    const header = `### ${f.filename} (${f.status}, +${f.additions} -${f.deletions})\n`;
    const patch = f.patch ? "```diff\n" + f.patch + "\n```\n" : "_(no textual diff — binary or too large)_\n";
    if (out.length + header.length + patch.length > MAX_DIFF_CHARS) {
      out += "\n… [diff truncated]\n";
      break;
    }
    out += header + patch + "\n";
  }
  return out || "_(empty diff)_";
}

export default workflow({ name: "pr-review" }, async (ctx) => {
  const ev = ctx.input as NormalizedGitHubEvent;

  if (ev.kind !== "pull") return { skipped: "not a pull_request event" };
  if (ev.sender.type === "Bot") return { skipped: "bot sender" };
  if (ev.pull.draft) return { skipped: "draft PR" };
  if (!REVIEW_ACTIONS.has(ev.action)) return { skipped: `action ${ev.action}` };

  const { repo, pull } = ev;
  const gh = githubFromEnv();

  const { diff, files } = await ctx.step("load-diff", async () => {
    const f = await gh.listPullFiles(repo, pull.number);
    return { diff: renderDiff(f), files: f.length };
  });

  if (files === 0) return { skipped: "no files changed" };

  // Fan out to specialist reviewers as isolated, concurrent tasks.
  const [security, performance, correctness, tests] = await Promise.all([
    ctx.agents.get("security").task(diff),
    ctx.agents.get("performance").task(diff),
    ctx.agents.get("correctness").task(diff),
    ctx.agents.get("tests").task(diff),
  ]);

  const verdict = await ctx.step("judge", async () => {
    const combined = [
      `## Security\n${security.text}`,
      `## Performance\n${performance.text}`,
      `## Correctness\n${correctness.text}`,
      `## Tests\n${tests.text}`,
    ].join("\n\n");
    const out = await ctx.agents.get("judge").run<Verdict>(
      `Pull request #${pull.number}: ${pull.title}\n\n${pull.body}\n\n` +
        `Specialist reviews:\n\n${combined}\n\nDiff under review:\n\n${diff}`,
    );
    return (out.data ?? { decision: "request_changes", summary: out.text }) as Verdict;
  });

  await ctx.step("submit-review", async () => {
    await gh.createReview(repo, pull.number, {
      event: verdict.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES",
      body: `🤖 **Automated review — ${verdict.decision === "approve" ? "Approved" : "Changes requested"}**\n\n${verdict.summary}`,
      comments: verdict.inline_comments,
    });
    return { submitted: true };
  });

  return { decision: verdict.decision, pr: pull.htmlUrl };
});
