/**
 * pr-fix — Responds to review feedback on an agent-opened PR.
 * Bare Render task composing agent tasks via ctx.run().
 */
import { task } from "@renderinc/sdk/workflows";
import { implementTask } from "../tasks/index.js";
import { githubFromEnv } from "../lib/github.js";
import { RenderSandboxProvider } from "@render-factory/sandbox-render";
import { collectExecOutput } from "@render-factory/engine";
import type { NormalizedGitHubEvent } from "../lib/github-events.js";

export const prFix = task(
  { name: "pr-fix", plan: "standard" },
  async function prFix(input: unknown) {
    const ev = input as NormalizedGitHubEvent;
    if (ev.kind !== "pull") return { skipped: "not a pull event" };
    if (ev.sender.type === "Bot") return { skipped: "bot sender" };
    if (ev.action !== "submitted") return { skipped: `action ${ev.action}` };

    const { repo, pull } = ev;
    if (!pull.head.startsWith("agent/")) return { skipped: "not an agent branch" };

    const gh = githubFromEnv();
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is not set");

    const files = await gh.listPullFiles(repo, pull.number);
    const fileList = files.map((f) => f.filename);
    const pullDetail = await gh.getPull(repo, pull.number);
    const branch = pullDetail.head;

    const provider = new RenderSandboxProvider();
    const sandbox = await provider.create({ metadata: { pr: `${repo.owner}/${repo.repo}#${pull.number} fix` } });
    const sandboxId = sandbox.id;
    const dir = "/workspace";

    try {
      await sandbox.exec(
        `git config --global credential.helper store && ` +
        `printf 'https://x-access-token:%s@github.com\\n' '${token}' > ~/.git-credentials && ` +
        `git config --global user.name "render-agent" && ` +
        `git config --global user.email "render-agent@users.noreply.github.com"`,
      );
      const cloneEvents = await sandbox.exec(
        `git clone https://github.com/${repo.owner}/${repo.repo}.git ${dir} && cd ${dir} && git checkout ${branch}`,
      );
      const cloneResult = await collectExecOutput(cloneEvents);
      if (cloneResult.exitCode !== 0) throw new Error(`Clone failed: ${cloneResult.output.slice(0, 500).split(token).join("***")}`);

      const sandboxContext = `sandbox_id: ${sandboxId}\nrepoDir: ${dir}`;
      await implementTask(
        `${sandboxContext}\n\nPR #${pull.number}: ${pullDetail.title}\n\n` +
        `Fix the review feedback. Changed files: ${fileList.join(", ")}.\n\n` +
        `Original description:\n${pullDetail.body}`,
      );

      const statusEvents = await sandbox.exec(`cd ${dir} && git status --porcelain`);
      const { output: status } = await collectExecOutput(statusEvents);
      if (!status.trim()) return { status: "no_changes", pr: pull.htmlUrl };

      const commitEvents = await sandbox.exec(
        `cd ${dir} && git add -A && git commit -m "Address review feedback" && git push --force-with-lease origin ${branch}`,
      );
      const commitResult = await collectExecOutput(commitEvents);
      if (commitResult.exitCode !== 0) throw new Error(`Push failed: ${commitResult.output.slice(0, 500).split(token).join("***")}`);

      await gh.createIssueComment(repo, pull.number, "Pushed fixes addressing the review feedback.");
      return { status: "fixed", pr: pull.htmlUrl, branch };
    } finally {
      await sandbox.terminate();
    }
  },
);
