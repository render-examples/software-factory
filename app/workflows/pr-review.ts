/**
 * pr-review — Fan-out reviews, then judge synthesizes a GitHub review.
 */
import { task } from "@renderinc/sdk/workflows";
import { securityTask, performanceTask, correctnessTask, testsTask, lintTask, judgeTask } from "../tasks/index.js";
import { githubFromEnv, type PullFile, type ReviewComment } from "../lib/github.js";
import type { NormalizedGitHubEvent } from "../lib/github-events.js";
import { resolveRefs } from "#factory-sdk";

const REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
const MAX_DIFF_CHARS = 60_000;

function renderDiff(files: PullFile[]): string {
  let out = "";
  for (const f of files) {
    const header = `### ${f.filename} (${f.status}, +${f.additions} -${f.deletions})\n`;
    const patch = f.patch ? "```diff\n" + f.patch + "\n```\n" : "_(no textual diff)_\n";
    if (out.length + header.length + patch.length > MAX_DIFF_CHARS) { out += "\n… [truncated]\n"; break; }
    out += header + patch + "\n";
  }
  return out || "_(empty diff)_";
}

export const prReview = task(
  { name: "pr-review", plan: "standard" },
  async function prReview(input: unknown) {
    const ev = input as NormalizedGitHubEvent;
    if (ev.kind !== "pull") return { skipped: "not a pull_request event" };
    if (ev.sender.type === "Bot") return { skipped: "bot sender" };
    if (ev.pull.draft) return { skipped: "draft PR" };
    if (!REVIEW_ACTIONS.has(ev.action)) return { skipped: `action ${ev.action}` };

    const { repo, pull } = ev;
    const gh = githubFromEnv();
    const files = await gh.listPullFiles(repo, pull.number);
    if (files.length === 0) return { skipped: "no files changed" };
    const diff = renderDiff(files);
    // The gateway blob-caps oversized PR bodies; resolve before prompting.
    const pullBody = await resolveRefs(pull.body);

    const [secRaw, perfRaw, corrRaw, testsRaw, lintRaw] = await Promise.all([
      securityTask({ message: diff }),
      performanceTask({ message: diff }),
      correctnessTask({ message: diff }),
      testsTask({ message: diff }),
      lintTask({ message: diff }),
    ]);

    const combined = [
      `## Security\n${secRaw}`,
      `## Performance\n${perfRaw}`,
      `## Correctness\n${corrRaw}`,
      `## Tests\n${testsRaw}`,
      `## Lint\n${lintRaw}`,
    ].join("\n\n");

    const judgeRaw = await judgeTask({
      message: `Pull request #${pull.number}: ${pull.title}\n\n${pullBody}\n\nSpecialist reviews:\n\n${combined}\n\nDiff:\n\n${diff}`,
    });

    let decision: "approve" | "request_changes" = "request_changes";
    let summary = judgeRaw;
    try {
      const parsed = JSON.parse(judgeRaw);
      decision = parsed.decision ?? "request_changes";
      summary = parsed.summary ?? judgeRaw;
    } catch { /* use raw text */ }

    await gh.createReview(repo, pull.number, {
      event: decision === "approve" ? "APPROVE" : "REQUEST_CHANGES",
      body: `**Automated review — ${decision === "approve" ? "Approved" : "Changes requested"}**\n\n${summary}`,
    });

    return { decision, pr: pull.htmlUrl };
  },
);
