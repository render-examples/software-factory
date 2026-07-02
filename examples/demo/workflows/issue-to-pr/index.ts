import { workflow } from "@render-agents/sdk";
import { githubFromEnv, type Issue, type IssueComment } from "../../src/lib/github.js";
import { WorkspaceManager } from "../../src/lib/workspace.js";
import type { NormalizedGitHubEvent } from "../../src/lib/github-events.js";

// Issue -> PR (trigger: issues / issue_comment). Stateless re-evaluation: each
// event re-reads the issue from GitHub and uses labels as the state machine, so
// there are no paused runs to correlate.
//
//   issues.opened / issue_comment.created
//     -> triage: enough detail?
//        no  -> post questions + label `agent:needs-info`; stop
//        yes -> label `agent:working`; clone; Research -> Plan -> Implement
//               (in-process .run() so they share ONE checkout); commit + push;
//               open PR; comment the link + label `agent:done`.

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
    "👋 Thanks for opening this! Before I can implement it, I need a few more details:\n\n" +
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

  // --- Research -> Plan -> Implement on one shared checkout ---
  await ctx.step("mark-working", async () => {
    await gh.removeLabel(repo, number, NEEDS_INFO);
    await gh.addLabels(repo, number, [WORKING]);
    return { ok: true };
  });

  const ws = new WorkspaceManager();
  const key = `issue-${number}`;
  const branch = `agent/issue-${number}`;

  // Not wrapped in ctx.step: cloning is idempotent and must actually exist on the
  // container running the agents (a memoized step would return a path a fresh
  // container wouldn't have). The agents below use .run() (in-process) so they
  // share THIS checkout.
  const dir = await ws.ensureCheckout({ owner: repo.owner, repo: repo.repo, key, token, ref: repo.defaultBranch });
  await ws.createBranch(dir, branch);

  const research = await ctx.agents.get("researcher").run(
    `The repository is checked out at:\n  repoDir: ${dir}\n\nIssue #${number}: ${issue.title}\n\n${issue.body}`,
  );

  const plan = await ctx.agents.get("planner").run<PlanOut>(
    `repoDir: ${dir}\n\nIssue #${number}: ${issue.title}\n\n${issue.body}\n\nResearch brief:\n${research.text}`,
  );
  const planText = plan.data ? JSON.stringify(plan.data, null, 2) : plan.text;

  const impl = await ctx.agents.get("implementer").run(
    `repoDir: ${dir}\n\nIssue #${number}: ${issue.title}\n\nApproved plan:\n${planText}`,
  );

  // --- commit + push (deterministic side effects) ---
  const committed = await ctx.step("commit-push", async () => {
    const changed = await ws.commitAll(dir, `Fix #${number}: ${issue.title}`);
    if (!changed) return { changed: false };
    await ws.push(dir, branch);
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
    await ws.cleanup(key);
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
    await gh.createIssueComment(repo, number, `🤖 Opened a pull request: ${pr.htmlUrl}`);
    await gh.removeLabel(repo, number, WORKING);
    await gh.addLabels(repo, number, [DONE]);
    return { ok: true };
  });

  await ws.cleanup(key);
  return { status: "pr_opened", pr: pr.htmlUrl, branch };
});
