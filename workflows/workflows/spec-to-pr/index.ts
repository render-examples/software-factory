import { workflow } from "@render-factory/sdk";
import { githubFromEnv, type GitHub, type Issue, type IssueComment, type RepoRef } from "../../lib/github.js";
import { RenderSandboxProvider } from "@render-factory/sandbox-render";
import { collectExecOutput } from "@render-factory/engine";
import type { NormalizedGitHubEvent } from "../../lib/github-events.js";

/**
 * Channel-agnostic spec input. The assistant's `start_workflow` tool composes
 * this from conversation; the GitHub channel adapter normalizes issue events
 * into this shape.
 */
export interface SpecInput {
  title: string;
  description: string;
  repo: { owner: string; repo: string };
  issueNumber?: number;
}

interface TriageOut {
  hasEnoughDetail: boolean;
  questions: string[];
  rationale?: string;
}
interface PlanOut {
  summary: string;
  steps: string[];
  files?: string[];
  risks?: string[];
}

const NEEDS_INFO = "agent:needs-info";
const WORKING = "agent:working";
const DONE = "agent:done";
const FAILED = "agent:failed";
const MAX_TEXT = 12_000;

function isBot(sender: { login: string; type: string }): boolean {
  return (
    sender.type === "Bot" ||
    sender.login.endsWith("[bot]") ||
    sender.login === process.env.GITHUB_BOT_LOGIN
  );
}

function renderIssue(issue: Issue, comments: IssueComment[]): string {
  const parts = [`# ${issue.title}`, "", issue.body || "(no description)"];
  if (comments.length > 0) {
    parts.push("", "## Comments");
    for (const c of comments) parts.push(`### @${c.user}`, c.body);
  }
  return parts.join("\n").slice(0, MAX_TEXT);
}

function renderQuestions(questions: string[]): string {
  const list = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return (
    "Thanks for opening this! Before I can implement it, I need a few more details:\n\n" +
    `${list}\n\n` +
    "_Reply here with the specifics and I'll pick this up automatically._"
  );
}

/**
 * Normalize input: accept either a direct SpecInput (from start_workflow / API)
 * or a NormalizedGitHubEvent (from the GitHub channel).
 */
function normalizeInput(raw: unknown): { spec: SpecInput; isGitHubIssue: boolean } | { skipped: string } {
  const input = raw as Record<string, unknown>;

  if (input.title && input.description && input.repo) {
    return { spec: input as unknown as SpecInput, isGitHubIssue: false };
  }

  if (input.kind === "issue") {
    const ev = raw as Extract<NormalizedGitHubEvent, { kind: "issue" }>;
    if (ev.issue.isPullRequest) return { skipped: "issue is a PR conversation" };
    if (isBot(ev.sender)) return { skipped: "bot sender (loop guard)" };
    if (ev.event === "issues" && !["opened", "reopened"].includes(ev.action)) {
      return { skipped: `issues action ${ev.action}` };
    }
    if (ev.event === "issue_comment" && ev.action !== "created") {
      return { skipped: `issue_comment action ${ev.action}` };
    }
    return {
      spec: {
        title: ev.issue.title,
        description: ev.issue.body,
        repo: { owner: ev.repo.owner, repo: ev.repo.repo },
        issueNumber: ev.issue.number,
      },
      isGitHubIssue: true,
    };
  }

  return { skipped: "unrecognized input format" };
}

export default workflow({ name: "spec-to-pr" }, async (ctx) => {
  const normalized = normalizeInput(ctx.input);
  if ("skipped" in normalized) return { skipped: normalized.skipped };

  const { spec, isGitHubIssue } = normalized;
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const gh = githubFromEnv();
  const repo: RepoRef = spec.repo;

  // GitHub issue path: load fresh state, label state machine, triage
  if (isGitHubIssue && spec.issueNumber) {
    const number = spec.issueNumber;

    const { issue, comments } = await ctx.step("load-issue", async () => ({
      issue: await gh.getIssue(repo, number),
      comments: await gh.listIssueComments(repo, number),
    }));

    if (issue.labels.includes(DONE)) return { skipped: "already done" };
    if (issue.labels.includes(WORKING)) return { skipped: "already in progress" };

    const triage = await ctx.agents.get("triage").run<TriageOut>(renderIssue(issue, comments));
    const t: TriageOut = triage.data ?? { hasEnoughDetail: false, questions: [] };

    if (!t.hasEnoughDetail) {
      const questions = t.questions.length > 0 ? t.questions : ["Could you share more detail about the desired outcome?"];
      await ctx.step("ask-questions", async () => {
        await gh.createIssueComment(repo, number, renderQuestions(questions));
        await gh.addLabels(repo, number, [NEEDS_INFO]);
        return { asked: questions.length };
      });
      return { status: "asked", questions };
    }

    await ctx.step("mark-working", async () => {
      await gh.removeLabel(repo, number, NEEDS_INFO);
      await gh.addLabels(repo, number, [WORKING]);
      return { ok: true };
    });
  }

  // Core pipeline: sandbox -> research -> plan -> implement -> PR
  const provider = new RenderSandboxProvider();
  const sandbox = await provider.create({
    metadata: { spec: `${repo.owner}/${repo.repo}: ${spec.title}` },
  });
  const sandboxId = sandbox.id;
  const branch = spec.issueNumber ? `agent/issue-${spec.issueNumber}` : `agent/spec-${Date.now()}`;
  const dir = "/workspace";

  const cloneUrl = `https://x-access-token:${token}@github.com/${repo.owner}/${repo.repo}.git`;
  const cloneEvents = await sandbox.exec(
    `git clone ${cloneUrl} ${dir} && cd ${dir} && git checkout -B ${branch}`,
  );
  const cloneResult = await collectExecOutput(cloneEvents);
  if (cloneResult.exitCode !== 0) {
    await sandbox.terminate();
    throw new Error(`Clone failed: ${cloneResult.output.slice(0, 500)}`);
  }

  const sandboxContext = `sandbox_id: ${sandboxId}\nrepoDir: ${dir}`;

  const research = await ctx.agents.get("researcher").run(
    `${sandboxContext}\n\n${spec.title}\n\n${spec.description}`,
  );

  const plan = await ctx.agents.get("planner").run<PlanOut>(
    `${sandboxContext}\n\n${spec.title}\n\n${spec.description}\n\nResearch brief:\n${research.text}`,
  );
  const planText = plan.data ? JSON.stringify(plan.data, null, 2) : plan.text;

  const impl = await ctx.agents.get("implementer").run(
    `${sandboxContext}\n\n${spec.title}\n\nApproved plan:\n${planText}`,
  );

  const committed = await ctx.step("commit-push", async () => {
    const statusEvents = await sandbox.exec(`cd ${dir} && git status --porcelain`);
    const { output: status } = await collectExecOutput(statusEvents);
    if (!status.trim()) return { changed: false };
    const commitMsg = spec.issueNumber
      ? `Fix #${spec.issueNumber}: ${spec.title}`
      : spec.title;
    const commitEvents = await sandbox.exec(
      `cd ${dir} && git add -A && git commit -m ${JSON.stringify(commitMsg)} && git push --force-with-lease origin ${branch}`,
    );
    const { exitCode, output } = await collectExecOutput(commitEvents);
    if (exitCode !== 0) throw new Error(`Commit/push failed: ${output.slice(0, 500)}`);
    return { changed: true };
  });

  if (!committed.changed) {
    if (isGitHubIssue && spec.issueNumber) {
      await ctx.step("no-changes", async () => {
        await gh.createIssueComment(repo, spec.issueNumber!,
          "I finished a pass but produced no file changes, so I'm not opening a PR. Could you clarify the expected change?");
        await gh.removeLabel(repo, spec.issueNumber!, WORKING);
        await gh.addLabels(repo, spec.issueNumber!, [FAILED]);
        return { ok: true };
      });
    }
    await sandbox.terminate();
    return { status: "no_changes" };
  }

  const pr = await ctx.step("open-pr", async () =>
    gh.ensurePull(repo, {
      title: spec.issueNumber ? `Fix #${spec.issueNumber}: ${spec.title}` : spec.title,
      head: branch,
      base: "main",
      body: spec.issueNumber
        ? `Automated implementation for #${spec.issueNumber}.\n\n${impl.text}\n\nCloses #${spec.issueNumber}.`
        : impl.text,
    }),
  );

  if (isGitHubIssue && spec.issueNumber) {
    await ctx.step("finish", async () => {
      await gh.createIssueComment(repo, spec.issueNumber!, `Opened a pull request: ${pr.htmlUrl}`);
      await gh.removeLabel(repo, spec.issueNumber!, WORKING);
      await gh.addLabels(repo, spec.issueNumber!, [DONE]);
      return { ok: true };
    });
  }

  await sandbox.terminate();
  return { status: "pr_opened", pr: pr.htmlUrl, branch };
});
