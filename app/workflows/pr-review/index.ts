import { defineWorkflow, notifyThreadSurfaces } from "@render-factory/sdk";
import type { AgentRuntime } from "@render-factory/sdk";
import { security, performance, correctness, tests, lint, judge } from "../../agents/index.js";
import { githubFromEnv, type PullFile, type ReviewComment } from "../../lib/github.js";
import type { NormalizedGitHubEvent } from "../../lib/github-events.js";
import { RenderSandboxProvider } from "@render-factory/sandbox-render";
import { collectExecOutput } from "@render-factory/engine";

// Fan-out: five specialist reviewers run in parallel, then judge synthesizes.
// Uses task() because reviewers are independent and benefit from separate
// containers. Uses run() for the final judge step (sequential, needs all results).

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

export default defineWorkflow({
  id: "pr-review",
  agents: [security, performance, correctness, tests, lint, judge] as const,
  run: async (ctx) => {
  const rt = ctx.runtime as AgentRuntime;
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

  const provider = new RenderSandboxProvider();
  const sandbox = await provider.create({ metadata: { pr: `${repo.owner}/${repo.repo}#${pull.number}` } });
  const sandboxId = sandbox.id;
  const dir = "/workspace";

  try {
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      await sandbox.exec(
        `git config --global credential.helper store && ` +
        `printf 'https://x-access-token:%s@github.com\\n' '${token}' > ~/.git-credentials`,
      );
    }
    await sandbox.exec(
      `git clone https://github.com/${repo.owner}/${repo.repo}.git ${dir} && cd ${dir} && git fetch origin pull/${pull.number}/head:pr && git checkout pr`,
    );

    const sandboxContext = `sandbox_id: ${sandboxId}\nrepoDir: ${dir}`;

    const [secReview, perfReview, corrReview, testsReview, lintReview] = await Promise.all([
      ctx.task(security, diff),
      ctx.task(performance, diff),
      ctx.task(correctness, diff),
      ctx.task(tests, diff),
      ctx.task(lint, sandboxContext),
    ]);

    const verdict = await ctx.step("judge", async () => {
      const combined = [
        `## Security\n${secReview.text}`,
        `## Performance\n${perfReview.text}`,
        `## Correctness\n${corrReview.text}`,
        `## Tests\n${testsReview.text}`,
        `## Lint\n${lintReview.text}`,
      ].join("\n\n");
      const out = await ctx.task<Verdict>(judge,
        `Pull request #${pull.number}: ${pull.title}\n\n${pull.body}\n\n` +
          `Specialist reviews:\n\n${combined}\n\nDiff under review:\n\n${diff}`,
      );
      return (out.data ?? { decision: "request_changes", summary: out.text }) as Verdict;
    });

    await ctx.step("submit-review", async () => {
      await gh.createReview(repo, pull.number, {
        event: verdict.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES",
        body: `**Automated review — ${verdict.decision === "approve" ? "Approved" : "Changes requested"}**\n\n${verdict.summary}`,
        comments: verdict.inline_comments,
      });
      return { submitted: true };
    });

    const run = await rt.store.getRun(ctx.runId);
    if (run?.threadId) {
      const resultMsg = `Review submitted for ${pull.htmlUrl}: ${verdict.decision}`;
      await rt.itemStore.appendItem({
        threadId: run.threadId,
        runId: ctx.runId,
        kind: "result",
        role: "system",
        content: resultMsg,
        data: { decision: verdict.decision, pr: pull.htmlUrl },
      });
      await notifyThreadSurfaces(rt, run.threadId, {
        kind: "result",
        content: resultMsg,
        data: { decision: verdict.decision, pr: pull.htmlUrl },
      });
    }

    return { decision: verdict.decision, pr: pull.htmlUrl };
  } finally {
    await sandbox.terminate();
  }
},
});
