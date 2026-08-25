import { workflow } from "@render-agents/sdk";
import { githubFromEnv, type Issue, type IssueComment } from "../../src/lib/github.js";
import { RenderSandboxProvider } from "@render-agents/sandbox-render";
import { collectExecOutput } from "@render-agents/engine";
import type { NormalizedGitHubEvent } from "../../src/lib/github-events.js";

const NEEDS_INFO = "agent:needs-info";
const WORKING = "agent:working";
const DONE = "agent:done";
const FAILED = "agent:failed";

const MAX_TEXT = 12_000;

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

export default workflow({ name: "issue-to-pr" }, async (ctx) => {
  const ev = ctx.input as NormalizedGitHubEvent;

  // --- gates ---
  if (ev.kind !== "issue") return { skipped: "not an issue event" };
  if (ev.issue.isPullRequest) return { skipped: "issue is a PR conversation" };
  if (isBot(ev.sender)) return { skipped: "bot sender (loop guard)" };
  if (ev.event === "issues" && !["opened", "reopened"].includes(ev.action)) {
    return { skipped: `issues action ${ev.action}` };
  }
  if (ev.event === "issue_comment" && ev.action !== "created") {
    return { skipped: `issue_comment action ${ev.action}` };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const gh = githubFromEnv();
  const { repo } = ev;
  const number = ev.issue.number;

  // Re-read fresh issue state (labels + all comments) — the source of truth.
  const { issue, comments } = await ctx.step("load-issue", async () => ({
    issue: await gh.getIssue(repo, number),
    comments: await gh.listIssueComments(repo, number),
  }));

  // --- label state machine (dedupe) ---
  if (issue.labels.includes(DONE)) return { skipped: "already done" };
  if (issue.labels.includes(WORKING)) return { skipped: "already in progress" };

  // --- triage ---
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

  // --- Provision sandbox, clone repo, run agents ---
  await ctx.step("mark-working", async () => {
    await gh.removeLabel(repo, number, NEEDS_INFO);
    await gh.addLabels(repo, number, [WORKING]);
    return { ok: true };
  });

  const provider = new RenderSandboxProvider();
  const sandbox = await provider.create({ metadata: { issue: `${repo.owner}/${repo.repo}#${number}` } });
  const sandboxId = sandbox.id;
  const branch = `agent/issue-${number}`;
  const dir = "/workspace";

  // Clone the repo into the sandbox
  const cloneUrl = `https://x-access-token:${token}@github.com/${repo.owner}/${repo.repo}.git`;
  const cloneEvents = await sandbox.exec(
    `git clone ${cloneUrl} ${dir} && cd ${dir} && git checkout -B ${branch}`,
  );
  const cloneResult = await collectExecOutput(cloneEvents);
  if (cloneResult.exitCode !== 0) {
    await sandbox.terminate();
    throw new Error(`Clone failed: ${cloneResult.output.slice(0, 500)}`);
  }

  // --- Research -> Plan -> Implement (agents use sandbox_id to route tool calls) ---
  const sandboxContext = `sandbox_id: ${sandboxId}\nrepoDir: ${dir}`;

  const research = await ctx.agents.get("researcher").run(
    `${sandboxContext}\n\nIssue #${number}: ${issue.title}\n\n${issue.body}`,
  );

  const plan = await ctx.agents.get("planner").run<PlanOut>(
    `${sandboxContext}\n\nIssue #${number}: ${issue.title}\n\n${issue.body}\n\nResearch brief:\n${research.text}`,
  );
  const planText = plan.data ? JSON.stringify(plan.data, null, 2) : plan.text;

  const impl = await ctx.agents.get("implementer").run(
    `${sandboxContext}\n\nIssue #${number}: ${issue.title}\n\nApproved plan:\n${planText}`,
  );

  // --- commit + push ---
  const committed = await ctx.step("commit-push", async () => {
    const statusEvents = await sandbox.exec(`cd ${dir} && git status --porcelain`);
    const { output: status } = await collectExecOutput(statusEvents);
    if (!status.trim()) return { changed: false };
    const commitEvents = await sandbox.exec(
      `cd ${dir} && git add -A && git commit -m "Fix #${number}: ${issue.title}" && git push --force-with-lease origin ${branch}`,
    );
    const { exitCode, output } = await collectExecOutput(commitEvents);
    if (exitCode !== 0) throw new Error(`Commit/push failed: ${output.slice(0, 500)}`);
    return { changed: true };
  });

  if (!committed.changed) {
    await ctx.step("no-changes", async () => {
      await gh.createIssueComment(
        repo,
        number,
        "I finished a pass but produced no file changes, so I'm not opening a PR. Could you clarify the expected change?",
      );
      await gh.removeLabel(repo, number, WORKING);
      await gh.addLabels(repo, number, [FAILED]);
      return { ok: true };
    });
    await sandbox.terminate();
    return { status: "no_changes" };
  }

  const pr = await ctx.step("open-pr", async () =>
    gh.ensurePull(repo, {
      title: `Fix #${number}: ${issue.title}`,
      head: branch,
      base: repo.defaultBranch,
      body: `Automated implementation for #${number}.\n\n${impl.text}\n\nCloses #${number}.`,
    }),
  );

  await ctx.step("finish", async () => {
    await gh.createIssueComment(repo, number, `Opened a pull request: ${pr.htmlUrl}`);
    await gh.removeLabel(repo, number, WORKING);
    await gh.addLabels(repo, number, [DONE]);
    return { ok: true };
  });

  await sandbox.terminate();
  return { status: "pr_opened", pr: pr.htmlUrl, branch };
});
