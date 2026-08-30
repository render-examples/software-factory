/** spec-to-pr — Triage → research → plan → implement → PR via Render Sandbox. */
import { task } from "@renderinc/sdk/workflows";
import { triageTask, researchTask, planTask, implementTask } from "../tasks/index.js";
import { githubFromEnv, type Issue, type IssueComment, type RepoRef } from "../lib/github.js";
import type { NormalizedGitHubEvent } from "../lib/github-events.js";
import { RenderSandboxProvider, collectExecOutput, resolveRefs } from "#factory-sdk";

interface SpecInput {
  title: string;
  description: string;
  repo: { owner: string; repo: string };
  issueNumber?: number;
}

const MAX_TEXT = 12_000;
const REPO_DIR = "/home/user/repo";

function isBot(sender: { login: string; type: string }): boolean {
  return sender.type === "Bot" || sender.login.endsWith("[bot]") || sender.login === process.env.GITHUB_BOT_LOGIN;
}

function renderIssue(issue: Issue, comments: IssueComment[]): string {
  const parts = [`# ${issue.title}`, "", issue.body || "(no description)"];
  if (comments.length > 0) {
    parts.push("", "## Comments");
    for (const c of comments) parts.push(`### @${c.user}`, c.body);
  }
  return parts.join("\n").slice(0, MAX_TEXT);
}

function sandboxContext(sandboxId: string): string {
  return `sandbox_id: ${sandboxId}\nrepoDir: ${REPO_DIR}`;
}

function normalizeInput(raw: unknown): { spec: SpecInput; isGitHubIssue: boolean } | { skipped: string } {
  const input = raw as Record<string, unknown>;
  if (input.title && input.description && input.repo) {
    return { spec: input as unknown as SpecInput, isGitHubIssue: false };
  }
  if (input.kind === "issue") {
    const ev = raw as Extract<NormalizedGitHubEvent, { kind: "issue" }>;
    if (ev.issue.isPullRequest) return { skipped: "issue is a PR conversation" };
    if (isBot(ev.sender)) return { skipped: "bot sender" };
    if (ev.event === "issues" && !["opened", "reopened"].includes(ev.action)) return { skipped: `issues action ${ev.action}` };
    if (ev.event === "issue_comment" && ev.action !== "created") return { skipped: `issue_comment action ${ev.action}` };
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

export const specToPr = task(
  { name: "spec-to-pr", plan: "standard" },
  async function specToPr(input: unknown) {
    const normalized = normalizeInput(input);
    if ("skipped" in normalized) return { skipped: normalized.skipped };

    const { isGitHubIssue } = normalized;
    // The gateway blob-caps oversized issue bodies, so the description may be
    // a `$blob:` ref. Resolve it before it reaches any agent prompt.
    const spec: SpecInput = {
      ...normalized.spec,
      description: await resolveRefs(normalized.spec.description),
    };
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is not set");
    const gh = githubFromEnv();
    const repo: RepoRef = spec.repo;

    // --- Triage ---
    if (isGitHubIssue && spec.issueNumber) {
      const issue = await gh.getIssue(repo, spec.issueNumber);
      const comments = await gh.listIssueComments(repo, spec.issueNumber);
      if (issue.labels.includes("factory:done")) return { skipped: "already done" };
      if (issue.labels.includes("factory:working")) return { skipped: "already in progress" };

      const triageRaw = await triageTask({ message: renderIssue(issue, comments) });
      let hasEnoughDetail = false;
      try { hasEnoughDetail = JSON.parse(triageRaw).hasEnoughDetail; } catch { /* not parseable */ }

      if (!hasEnoughDetail) {
        let questions: string[] = [];
        try { questions = JSON.parse(triageRaw).questions ?? []; } catch { /* not parseable */ }
        if (questions.length === 0) questions = ["Could you share more detail about the desired outcome?"];
        const list = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
        await gh.createIssueComment(repo, spec.issueNumber,
          `Thanks for opening this! Before I can implement it, I need a few more details:\n\n${list}\n\n_Reply here with the specifics and I'll pick this up automatically._`);
        await gh.addLabels(repo, spec.issueNumber, ["factory:needs-info"]);
        return { status: "asked", questions };
      }

      await gh.removeLabel(repo, spec.issueNumber, "factory:needs-info");
      await gh.addLabels(repo, spec.issueNumber, ["factory:working"]);
    }

    // --- Sandbox: research → plan → implement ---
    const provider = new RenderSandboxProvider();
    const sandbox = await provider.create({
      metadata: {
        workflow: "spec-to-pr",
        repo: `${repo.owner}/${repo.repo}`,
        ...(spec.issueNumber ? { issue: String(spec.issueNumber) } : {}),
      },
    });

    const branch = spec.issueNumber
      ? `agent/issue-${spec.issueNumber}`
      : `agent/spec-${Date.now()}`;

    try {
      const cloneUrl = `https://oauth2:${token}@github.com/${repo.owner}/${repo.repo}.git`;
      const cloneEvents = await sandbox.exec(
        `git clone --depth=50 ${cloneUrl} ${REPO_DIR} && cd ${REPO_DIR} && git checkout -b ${branch}`,
      );
      const { exitCode: cloneExit, output: cloneOut } = await collectExecOutput(cloneEvents);
      if (cloneExit !== 0) throw new Error(`Clone failed: ${cloneOut.slice(0, 500)}`);

      const gitConfigEvents = await sandbox.exec(
        `cd ${REPO_DIR} && git config user.name "render-factory[bot]" && git config user.email "bot@render-factory.dev"`,
      );
      await collectExecOutput(gitConfigEvents);

      const ctx = sandboxContext(sandbox.id);
      const researchBrief = await researchTask({
        message: `${ctx}\n\n${spec.title}\n\n${spec.description}`,
      });

      const planRaw = await planTask({
        message: `${spec.title}\n\n${spec.description}\n\nResearch brief:\n${researchBrief}`,
      });

      const implResult = await implementTask({
        message: `${ctx}\n\n${spec.title}\n\nApproved plan:\n${planRaw}`,
      });

      const pushEvents = await sandbox.exec(
        `cd ${REPO_DIR} && git add -A && git diff --cached --quiet || git commit -m "Implement: ${spec.title}" && git push origin ${branch}`,
      );
      const { exitCode: pushExit, output: pushOut } = await collectExecOutput(pushEvents);
      if (pushExit !== 0) throw new Error(`Push failed: ${pushOut.slice(0, 500)}`);

      const pr = await gh.ensurePull(repo, {
        title: spec.issueNumber ? `Fix #${spec.issueNumber}: ${spec.title}` : spec.title,
        head: branch,
        base: "main",
        body: spec.issueNumber
          ? `Automated implementation for #${spec.issueNumber}.\n\n${implResult}\n\nCloses #${spec.issueNumber}.`
          : implResult,
      });

      if (isGitHubIssue && spec.issueNumber) {
        await gh.createIssueComment(repo, spec.issueNumber, `Opened a pull request: ${pr.htmlUrl}`);
        await gh.removeLabel(repo, spec.issueNumber, "factory:working");
        await gh.addLabels(repo, spec.issueNumber, ["factory:done"]);
      }

      return { status: "pr_opened", pr: pr.htmlUrl, branch };
    } finally {
      await sandbox.terminate().catch(() => {});
    }
  },
);
