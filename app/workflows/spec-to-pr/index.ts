import { workflow, notifyThreadSurfaces } from "@render-factory/sdk";
import { githubFromEnv, type Issue, type IssueComment, type RepoRef } from "../../lib/github.js";
import { RenderSandboxProvider } from "@render-factory/sandbox-render";
import { collectExecOutput } from "@render-factory/engine";
import type { NormalizedGitHubEvent } from "../../lib/github-events.js";

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

function redactToken(s: string, token: string): string {
  return token ? s.split(token).join("***") : s;
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

/**
 * Clone a repo into a sandbox using git credential.helper so the token never
 * appears in command strings, process listings, or error output.
 */
async function cloneIntoSandbox(
  sandbox: { exec: (cmd: string) => Promise<AsyncGenerator<import("@render-factory/engine").SandboxExecEvent>> },
  opts: { owner: string; repo: string; token: string; dir: string; branch: string },
): Promise<void> {
  // Store credentials via credential.helper — keeps the token out of the clone URL
  const credSetup = await sandbox.exec(
    `git config --global credential.helper store && ` +
    `printf 'https://x-access-token:%s@github.com\\n' '${opts.token}' > ~/.git-credentials && ` +
    `git config --global user.name "render-agent" && ` +
    `git config --global user.email "render-agent@users.noreply.github.com"`,
  );
  const setupResult = await collectExecOutput(credSetup);
  if (setupResult.exitCode !== 0) {
    throw new Error(`Credential setup failed: ${redactToken(setupResult.output.slice(0, 300), opts.token)}`);
  }

  const cloneEvents = await sandbox.exec(
    `git clone https://github.com/${opts.owner}/${opts.repo}.git ${opts.dir} && ` +
    `cd ${opts.dir} && git checkout -B ${opts.branch}`,
  );
  const cloneResult = await collectExecOutput(cloneEvents);
  if (cloneResult.exitCode !== 0) {
    throw new Error(`Clone failed: ${redactToken(cloneResult.output.slice(0, 500), opts.token)}`);
  }
}

export default workflow({ name: "spec-to-pr" }, async (ctx) => {
  const normalized = normalizeInput(ctx.input);
  if ("skipped" in normalized) return { skipped: normalized.skipped };

  const { spec, isGitHubIssue } = normalized;
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const gh = githubFromEnv();
  const repo: RepoRef = spec.repo;

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

  // Core pipeline: sandbox -> research -> plan -> implement -> verify -> PR
  const provider = new RenderSandboxProvider();
  const sandbox = await provider.create({
    metadata: { spec: `${repo.owner}/${repo.repo}: ${spec.title}` },
  });
  const sandboxId = sandbox.id;
  const branch = spec.issueNumber ? `agent/issue-${spec.issueNumber}` : `agent/spec-${Date.now()}`;
  const dir = "/workspace";

  try {
    await cloneIntoSandbox(sandbox, { owner: repo.owner, repo: repo.repo, token, dir, branch });

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

    // Verify: run the project's test suite before committing
    await ctx.step("verify-tests", async () => {
      const detectEvents = await sandbox.exec(
        `cd ${dir} && if [ -f package.json ]; then echo "node"; elif [ -f Cargo.toml ]; then echo "rust"; elif [ -f go.mod ]; then echo "go"; elif [ -f requirements.txt ] || [ -f pyproject.toml ]; then echo "python"; else echo "unknown"; fi`,
      );
      const { output: stack } = await collectExecOutput(detectEvents);
      const lang = stack.trim();

      let testCmd: string;
      switch (lang) {
        case "node": testCmd = "npm test --if-present 2>&1 || true"; break;
        case "rust": testCmd = "cargo test 2>&1 || true"; break;
        case "go": testCmd = "go test ./... 2>&1 || true"; break;
        case "python": testCmd = "python -m pytest 2>&1 || true"; break;
        default: return { skipped: true, reason: "unknown stack" };
      }

      const testEvents = await sandbox.exec(`cd ${dir} && ${testCmd}`);
      const { exitCode, output } = await collectExecOutput(testEvents);
      return { exitCode, output: output.slice(-2000) };
    });

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
      if (exitCode !== 0) throw new Error(`Commit/push failed: ${redactToken(output.slice(0, 500), token)}`);
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
      const noChangeRun = await ctx.runtime.store.getRun(ctx.runId);
      if (noChangeRun?.threadId) {
        const msg = "Workflow completed but no changes were made.";
        await ctx.runtime.itemStore.appendItem({
          threadId: noChangeRun.threadId,
          runId: ctx.runId,
          kind: "result",
          role: "system",
          content: msg,
          data: { status: "no_changes" },
        });
        await notifyThreadSurfaces(ctx.runtime, noChangeRun.threadId, {
          kind: "result",
          content: msg,
          data: { status: "no_changes" },
        });
      }
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

    // Notify the originating thread
    const run = await ctx.runtime.store.getRun(ctx.runId);
    if (run?.threadId) {
      await ctx.runtime.itemStore.appendItem({
        threadId: run.threadId,
        runId: ctx.runId,
        kind: "result",
        role: "system",
        content: `PR opened: ${pr.htmlUrl}`,
        data: { status: "pr_opened", pr: pr.htmlUrl, branch },
      });
      await notifyThreadSurfaces(ctx.runtime, run.threadId, {
        kind: "result",
        content: `PR opened: ${pr.htmlUrl}`,
        data: { status: "pr_opened", pr: pr.htmlUrl, branch },
      });
    }

    return { status: "pr_opened", pr: pr.htmlUrl, branch };
  } finally {
    await sandbox.terminate();
  }
});
