/**
 * spec-to-pr — Triage, research, plan, implement, open PR.
 *
 * Bare Render task that composes agent tasks via ctx.run().
 * When Render ships workflow() + ctx.step(), this becomes a workflow.
 */
import { task } from "@renderinc/sdk/workflows";
import { matchesRepoAllowlist, notifyThreadSurfaces } from "@render-factory/sdk";
import type { AgentRuntime } from "@render-factory/sdk";
import { triageTask, researchTask, planTask, implementTask } from "../tasks/index.js";
import { githubFromEnv, type Issue, type IssueComment, type RepoRef } from "../lib/github.js";
import { RenderSandboxProvider } from "@render-factory/sandbox-render";
import { collectExecOutput } from "@render-factory/engine";
import type { NormalizedGitHubEvent } from "../lib/github-events.js";

export interface SpecInput {
  title: string;
  description: string;
  repo: { owner: string; repo: string };
  issueNumber?: number;
}

const NEEDS_INFO = "factory:needs-info";
const WORKING = "factory:working";
const DONE = "factory:done";
const FAILED = "factory:failed";
const MAX_TEXT = 12_000;

function isBot(sender: { login: string; type: string }): boolean {
  return sender.type === "Bot" || sender.login.endsWith("[bot]") || sender.login === process.env.GITHUB_BOT_LOGIN;
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
  return "Thanks for opening this! Before I can implement it, I need a few more details:\n\n" +
    `${list}\n\n_Reply here with the specifics and I'll pick this up automatically._`;
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

async function cloneIntoSandbox(
  sandbox: { exec: (cmd: string) => Promise<AsyncGenerator<import("@render-factory/engine").SandboxExecEvent>> },
  opts: { owner: string; repo: string; token: string; dir: string; branch: string },
): Promise<void> {
  const credSetup = await sandbox.exec(
    `git config --global credential.helper store && ` +
    `printf 'https://x-access-token:%s@github.com\\n' '${opts.token}' > ~/.git-credentials && ` +
    `git config --global user.name "render-agent" && ` +
    `git config --global user.email "render-agent@users.noreply.github.com"`,
  );
  const setupResult = await collectExecOutput(credSetup);
  if (setupResult.exitCode !== 0) throw new Error(`Credential setup failed: ${redactToken(setupResult.output.slice(0, 300), opts.token)}`);

  const cloneEvents = await sandbox.exec(
    `git clone https://github.com/${opts.owner}/${opts.repo}.git ${opts.dir} && cd ${opts.dir} && git checkout -B ${opts.branch}`,
  );
  const cloneResult = await collectExecOutput(cloneEvents);
  if (cloneResult.exitCode !== 0) throw new Error(`Clone failed: ${redactToken(cloneResult.output.slice(0, 500), opts.token)}`);
}

export const specToPr = task(
  { name: "spec-to-pr", plan: "standard" },
  async function specToPr(input: unknown) {
    const normalized = normalizeInput(input);
    if ("skipped" in normalized) return { skipped: normalized.skipped };

    const { spec, isGitHubIssue } = normalized;

    const repoAllowlist = process.env.RENDER_FACTORY_REPOS;
    if (repoAllowlist) {
      const patterns = repoAllowlist.split(",").map((s) => s.trim()).filter(Boolean);
      const repoFullName = `${spec.repo.owner}/${spec.repo.repo}`;
      if (!matchesRepoAllowlist(repoFullName, patterns)) return { skipped: `repo ${repoFullName} not in allowlist` };
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is not set");
    const gh = githubFromEnv();
    const repo: RepoRef = spec.repo;

    if (isGitHubIssue && spec.issueNumber) {
      const number = spec.issueNumber;
      const issue = await gh.getIssue(repo, number);
      const comments = await gh.listIssueComments(repo, number);
      if (issue.labels.includes(DONE)) return { skipped: "already done" };
      if (issue.labels.includes(WORKING)) return { skipped: "already in progress" };

      const triageResult = await triageTask(renderIssue(issue, comments));
      const t = (triageResult as { data?: { hasEnoughDetail: boolean; questions: string[] } })?.data ?? { hasEnoughDetail: false, questions: [] };

      if (!t.hasEnoughDetail) {
        const questions = t.questions.length > 0 ? t.questions : ["Could you share more detail about the desired outcome?"];
        await gh.createIssueComment(repo, number, renderQuestions(questions));
        await gh.addLabels(repo, number, [NEEDS_INFO]);
        return { status: "asked", questions };
      }

      await gh.removeLabel(repo, number, NEEDS_INFO);
      await gh.addLabels(repo, number, [WORKING]);
    }

    const provider = new RenderSandboxProvider();
    const sandbox = await provider.create({ metadata: { spec: `${repo.owner}/${repo.repo}: ${spec.title}` } });
    const sandboxId = sandbox.id;
    const branch = spec.issueNumber ? `agent/issue-${spec.issueNumber}` : `agent/spec-${Date.now()}`;
    const dir = "/workspace";

    try {
      await cloneIntoSandbox(sandbox, { owner: repo.owner, repo: repo.repo, token, dir, branch });
      const sandboxContext = `sandbox_id: ${sandboxId}\nrepoDir: ${dir}`;

      await researchTask(`${sandboxContext}\n\n${spec.title}\n\n${spec.description}`);
      const planResult = await planTask(`${sandboxContext}\n\n${spec.title}\n\n${spec.description}\n\nResearch brief:\n(see previous agent output)`);
      const planText = (planResult as { data?: unknown })?.data ? JSON.stringify((planResult as { data?: unknown }).data, null, 2) : "(plan)";

      await implementTask(`${sandboxContext}\n\n${spec.title}\n\nApproved plan:\n${planText}`);

      const detectEvents = await sandbox.exec(
        `cd ${dir} && if [ -f package.json ]; then echo "node"; elif [ -f Cargo.toml ]; then echo "rust"; elif [ -f go.mod ]; then echo "go"; elif [ -f requirements.txt ] || [ -f pyproject.toml ]; then echo "python"; else echo "unknown"; fi`,
      );
      const { output: stack } = await collectExecOutput(detectEvents);
      const lang = stack.trim();
      const testCmds: Record<string, string> = { node: "npm test --if-present 2>&1 || true", rust: "cargo test 2>&1 || true", go: "go test ./... 2>&1 || true", python: "python -m pytest 2>&1 || true" };
      if (testCmds[lang]) {
        const testEvents = await sandbox.exec(`cd ${dir} && ${testCmds[lang]}`);
        await collectExecOutput(testEvents);
      }

      const statusEvents = await sandbox.exec(`cd ${dir} && git status --porcelain`);
      const { output: status } = await collectExecOutput(statusEvents);
      if (!status.trim()) {
        if (isGitHubIssue && spec.issueNumber) {
          await gh.createIssueComment(repo, spec.issueNumber, "I finished a pass but produced no file changes. Could you clarify the expected change?");
          await gh.removeLabel(repo, spec.issueNumber, WORKING);
          await gh.addLabels(repo, spec.issueNumber, [FAILED]);
        }
        return { status: "no_changes" };
      }

      const commitMsg = spec.issueNumber ? `Fix #${spec.issueNumber}: ${spec.title}` : spec.title;
      const commitEvents = await sandbox.exec(`cd ${dir} && git add -A && git commit -m ${JSON.stringify(commitMsg)} && git push --force-with-lease origin ${branch}`);
      const commitResult = await collectExecOutput(commitEvents);
      if (commitResult.exitCode !== 0) throw new Error(`Commit/push failed: ${redactToken(commitResult.output.slice(0, 500), token)}`);

      const pr = await gh.ensurePull(repo, {
        title: spec.issueNumber ? `Fix #${spec.issueNumber}: ${spec.title}` : spec.title,
        head: branch,
        base: "main",
        body: spec.issueNumber ? `Automated implementation for #${spec.issueNumber}.\n\nCloses #${spec.issueNumber}.` : "(implementation)",
      });

      if (isGitHubIssue && spec.issueNumber) {
        await gh.createIssueComment(repo, spec.issueNumber, `Opened a pull request: ${pr.htmlUrl}`);
        await gh.removeLabel(repo, spec.issueNumber, WORKING);
        await gh.addLabels(repo, spec.issueNumber, [DONE]);
      }

      return { status: "pr_opened", pr: pr.htmlUrl, branch };
    } finally {
      await sandbox.terminate();
    }
  },
);
