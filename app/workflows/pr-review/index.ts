import { workflow, notifyThreadSurfaces } from "@render-factory/sdk";
import { githubFromEnv, type PullFile, type ReviewComment } from "../../lib/github.js";
import type { NormalizedGitHubEvent } from "../../lib/github-events.js";
import { RenderSandboxProvider } from "@render-factory/sandbox-render";
import { collectExecOutput } from "@render-factory/engine";

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

  // Spin up a sandbox for the lint agent to run the project's linter
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

    // Fan out to specialist reviewers + lint as concurrent tasks
    const [security, performance, correctness, tests, lint] = await Promise.all([
      ctx.agents.get("security").task(diff),
      ctx.agents.get("performance").task(diff),
      ctx.agents.get("correctness").task(diff),
      ctx.agents.get("tests").task(diff),
      ctx.agents.get("lint").task(sandboxContext),
    ]);

    const verdict = await ctx.step("judge", async () => {
      const combined = [
        `## Security\n${security.text}`,
        `## Performance\n${performance.text}`,
        `## Correctness\n${correctness.text}`,
        `## Tests\n${tests.text}`,
        `## Lint\n${lint.text}`,
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
        body: `**Automated review — ${verdict.decision === "approve" ? "Approved" : "Changes requested"}**\n\n${verdict.summary}`,
        comments: verdict.inline_comments,
      });
      return { submitted: true };
    });

    // Notify the originating thread
    const run = await ctx.runtime.store.getRun(ctx.runId);
    if (run?.threadId) {
      const resultMsg = `Review submitted for ${pull.htmlUrl}: ${verdict.decision}`;
      await ctx.runtime.itemStore.appendItem({
        threadId: run.threadId,
        runId: ctx.runId,
        kind: "result",
        role: "system",
        content: resultMsg,
        data: { decision: verdict.decision, pr: pull.htmlUrl },
      });
      await notifyThreadSurfaces(ctx.runtime, run.threadId, {
        kind: "result",
        content: resultMsg,
        data: { decision: verdict.decision, pr: pull.htmlUrl },
      });
    }

    return { decision: verdict.decision, pr: pull.htmlUrl };
  } finally {
    await sandbox.terminate();
  }
});
