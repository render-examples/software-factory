/**
 * pr-review — Fan-out specialist reviews, then judge synthesizes a GitHub review.
 * Bare Render task composing agent tasks via ctx.run().
 */
import { task } from "@renderinc/sdk/workflows";
import { notifyThreadSurfaces } from "@render-factory/sdk";
import type { AgentRuntime } from "@render-factory/sdk";
import { securityTask, performanceTask, correctnessTask, testsTask, lintTask, judgeTask } from "../tasks/index.js";
import { githubFromEnv, type PullFile, type ReviewComment } from "../lib/github.js";
import type { NormalizedGitHubEvent } from "../lib/github-events.js";
import { RenderSandboxProvider } from "@render-factory/sandbox-render";

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
    const patch = f.patch ? "```diff\n" + f.patch + "\n```\n" : "_(no textual diff)_\n";
    if (out.length + header.length + patch.length > MAX_DIFF_CHARS) { out += "\n… [diff truncated]\n"; break; }
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
    const diff = renderDiff(files);
    if (files.length === 0) return { skipped: "no files changed" };

    const provider = new RenderSandboxProvider();
    const sandbox = await provider.create({ metadata: { pr: `${repo.owner}/${repo.repo}#${pull.number}` } });
    const sandboxId = sandbox.id;
    const dir = "/workspace";

    try {
      const token = process.env.GITHUB_TOKEN;
      if (token) {
        await sandbox.exec(
          `git config --global credential.helper store && printf 'https://x-access-token:%s@github.com\\n' '${token}' > ~/.git-credentials`,
        );
      }
      await sandbox.exec(
        `git clone https://github.com/${repo.owner}/${repo.repo}.git ${dir} && cd ${dir} && git fetch origin pull/${pull.number}/head:pr && git checkout pr`,
      );
      const sandboxContext = `sandbox_id: ${sandboxId}\nrepoDir: ${dir}`;

      const [secReview, perfReview, corrReview, testsReview, lintReview] = await Promise.all([
        securityTask(diff),
        performanceTask(diff),
        correctnessTask(diff),
        testsTask(diff),
        lintTask(sandboxContext),
      ]);

      const combined = [
        `## Security\n${(secReview as { text?: string })?.text ?? secReview}`,
        `## Performance\n${(perfReview as { text?: string })?.text ?? perfReview}`,
        `## Correctness\n${(corrReview as { text?: string })?.text ?? corrReview}`,
        `## Tests\n${(testsReview as { text?: string })?.text ?? testsReview}`,
        `## Lint\n${(lintReview as { text?: string })?.text ?? lintReview}`,
      ].join("\n\n");

      const judgeResult = await judgeTask(
        `Pull request #${pull.number}: ${pull.title}\n\n${pull.body}\n\nSpecialist reviews:\n\n${combined}\n\nDiff:\n\n${diff}`,
      );
      const verdict: Verdict = (judgeResult as { data?: Verdict })?.data ?? { decision: "request_changes", summary: String(judgeResult) };

      await gh.createReview(repo, pull.number, {
        event: verdict.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES",
        body: `**Automated review — ${verdict.decision === "approve" ? "Approved" : "Changes requested"}**\n\n${verdict.summary}`,
        comments: verdict.inline_comments,
      });

      return { decision: verdict.decision, pr: pull.htmlUrl };
    } finally {
      await sandbox.terminate();
    }
  },
);
