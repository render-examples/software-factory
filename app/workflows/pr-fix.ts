/**
 * pr-fix — Responds to review feedback on an agent-opened PR.
 */
import { task } from "@renderinc/sdk/workflows";
import { implementTask } from "../tasks/index.js";
import { githubFromEnv } from "../lib/github.js";
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
    const files = await gh.listPullFiles(repo, pull.number);
    const pullDetail = await gh.getPull(repo, pull.number);

    const implResult = await implementTask({
      message: `PR #${pull.number}: ${pullDetail.title}\n\n` +
        `Fix the review feedback. Changed files: ${files.map(f => f.filename).join(", ")}.\n\n` +
        `Original description:\n${pullDetail.body}`,
    });

    await gh.createIssueComment(repo, pull.number, `Pushed fixes.\n\n${implResult.slice(0, 1000)}`);
    return { status: "fixed", pr: pull.htmlUrl };
  },
);
