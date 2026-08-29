import { workflow, notifyThreadSurfaces } from "@render-factory/sdk";
import { githubFromEnv, type RepoRef } from "../../lib/github.js";
import { RenderSandboxProvider } from "@render-factory/sandbox-render";
import { collectExecOutput } from "@render-factory/engine";
import type { NormalizedGitHubEvent } from "../../lib/github-events.js";

/**
 * Responds to review feedback on a PR opened by the agent. Reads the review
 * comments, fixes the issues in a sandbox, pushes, and re-requests review.
 */
export default workflow({ name: "pr-fix" }, async (ctx) => {
  const ev = ctx.input as NormalizedGitHubEvent;

  if (ev.kind !== "pull") return { skipped: "not a pull event" };
  if (ev.sender.type === "Bot") return { skipped: "bot sender" };
  // Only respond to changes_requested on agent branches
  if (ev.action !== "submitted") return { skipped: `action ${ev.action}` };

  const { repo, pull } = ev;
  if (!pull.head.startsWith("agent/")) return { skipped: "not an agent branch" };

  const gh = githubFromEnv();
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");

  const reviewData = await ctx.step("load-reviews", async () => {
    const files = await gh.listPullFiles(repo, pull.number);
    return { files: files.length, fileList: files.map((f) => f.filename) };
  });

  const reviewContext = await ctx.step("build-context", async () => {
    const pullDetail = await gh.getPull(repo, pull.number);
    return {
      title: pullDetail.title,
      body: pullDetail.body,
      head: pullDetail.head,
    };
  });

  const provider = new RenderSandboxProvider();
  const sandbox = await provider.create({
    metadata: { pr: `${repo.owner}/${repo.repo}#${pull.number} fix` },
  });
  const sandboxId = sandbox.id;
  const dir = "/workspace";
  const branch = reviewContext.head;

  try {
    await sandbox.exec(
      `git config --global credential.helper store && ` +
      `printf 'https://x-access-token:%s@github.com\\n' '${token}' > ~/.git-credentials && ` +
      `git config --global user.name "render-agent" && ` +
      `git config --global user.email "render-agent@users.noreply.github.com"`,
    );
    const cloneEvents = await sandbox.exec(
      `git clone https://github.com/${repo.owner}/${repo.repo}.git ${dir} && ` +
      `cd ${dir} && git checkout ${branch}`,
    );
    const cloneResult = await collectExecOutput(cloneEvents);
    if (cloneResult.exitCode !== 0) {
      throw new Error(`Clone failed: ${cloneResult.output.slice(0, 500).split(token).join("***")}`);
    }

    const sandboxContext = `sandbox_id: ${sandboxId}\nrepoDir: ${dir}`;

    const impl = await ctx.agents.get("implementer").run(
      `${sandboxContext}\n\n` +
      `PR #${pull.number}: ${reviewContext.title}\n\n` +
      `This PR received review feedback requesting changes. ` +
      `Fix the issues raised in the review. The changed files are: ${reviewData.fileList.join(", ")}.\n\n` +
      `Original PR description:\n${reviewContext.body}`,
    );

    const pushed = await ctx.step("commit-push", async () => {
      const statusEvents = await sandbox.exec(`cd ${dir} && git status --porcelain`);
      const { output: status } = await collectExecOutput(statusEvents);
      if (!status.trim()) return { changed: false };
      const commitEvents = await sandbox.exec(
        `cd ${dir} && git add -A && ` +
        `git commit -m "Address review feedback" && ` +
        `git push --force-with-lease origin ${branch}`,
      );
      const { exitCode, output } = await collectExecOutput(commitEvents);
      if (exitCode !== 0) throw new Error(`Push failed: ${output.slice(0, 500).split(token).join("***")}`);
      return { changed: true };
    });

    if (!pushed.changed) {
      const noChangeRun = await ctx.runtime.store.getRun(ctx.runId);
      if (noChangeRun?.threadId) {
        const msg = `Review fix produced no changes for ${pull.htmlUrl}.`;
        await ctx.runtime.itemStore.appendItem({
          threadId: noChangeRun.threadId,
          runId: ctx.runId,
          kind: "result",
          role: "system",
          content: msg,
          data: { status: "no_changes", pr: pull.htmlUrl },
        });
        await notifyThreadSurfaces(ctx.runtime, noChangeRun.threadId, {
          kind: "result",
          content: msg,
          data: { status: "no_changes", pr: pull.htmlUrl },
        });
      }
      return { status: "no_changes", pr: pull.htmlUrl };
    }

    await ctx.step("comment", async () => {
      await gh.createIssueComment(
        repo,
        pull.number,
        `Pushed fixes addressing the review feedback.\n\n${impl.text.slice(0, 1000)}`,
      );
      return { ok: true };
    });

    const run = await ctx.runtime.store.getRun(ctx.runId);
    if (run?.threadId) {
      const resultMsg = `Pushed fixes for ${pull.htmlUrl} on branch ${branch}.`;
      await ctx.runtime.itemStore.appendItem({
        threadId: run.threadId,
        runId: ctx.runId,
        kind: "result",
        role: "system",
        content: resultMsg,
        data: { status: "fixed", pr: pull.htmlUrl, branch },
      });
      await notifyThreadSurfaces(ctx.runtime, run.threadId, {
        kind: "result",
        content: resultMsg,
        data: { status: "fixed", pr: pull.htmlUrl, branch },
      });
    }

    return { status: "fixed", pr: pull.htmlUrl, branch };
  } finally {
    await sandbox.terminate();
  }
});
