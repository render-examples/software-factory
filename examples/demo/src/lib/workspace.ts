// The RPI substrate: an ephemeral per-run working copy on the container's local
// filesystem. `WorkspaceManager` does git side effects (clone/branch/commit/push)
// from workflow `ctx.step()`s; the exported `runShell` + path-confinement helpers
// back the model-facing `tools/workspace` tools. Everything is confined under a
// single root so a tool call can't touch paths outside the checkout area.
//
// No persistent disk is required: a run clones fresh, works, opens a PR, and the
// container's local storage is reclaimed when it deprovisions. `ensureCheckout`
// is idempotent so a crash/redrive re-clones instead of relying on a memoized
// path that a fresh container wouldn't have.

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const pExecFile = promisify(execFile);

const EXEC_MAX_BUFFER = 16 * 1024 * 1024; // 16 MB
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const MAX_EXEC_TIMEOUT_MS = 600_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

/** Base directory that contains every run's checkout. Overridable via env. */
export function workspaceRoot(): string {
  return process.env.RENDER_WORKSPACE_DIR ?? path.join(os.tmpdir(), "render-agents-workspaces");
}

/**
 * Resolve a (possibly relative) path and assert it stays under the workspace
 * root — the confinement that makes the filesystem tools safe to expose.
 */
export function resolveWithinRoot(p: string): string {
  const root = path.resolve(workspaceRoot());
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path "${p}" escapes the workspace root`);
  }
  return abs;
}

function redact(s: string, secret?: string): string {
  return secret ? s.split(secret).join("***") : s;
}

/** Run a shell command string (for the model's `workspace__exec` tool). */
export async function runShell(
  cmd: string,
  opts: { cwd: string; timeoutMs?: number } = { cwd: workspaceRoot() },
): Promise<ExecResult> {
  const timeout = Math.min(opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS);
  return new Promise<ExecResult>((resolve) => {
    exec(
      cmd,
      {
        cwd: opts.cwd,
        timeout,
        maxBuffer: EXEC_MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: e && typeof e.code === "number" ? e.code : e ? 1 : 0,
          timedOut: Boolean(e?.killed),
        });
      },
    );
  });
}

/** Run `git` with explicit args (no shell). Never throws — returns the code. */
async function runGit(cwd: string, args: string[], secret?: string): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await pExecFile("git", args, {
      cwd,
      timeout: MAX_EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout, stderr, code: 0, timedOut: false };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; code?: number | string };
    return {
      stdout: e.stdout ?? "",
      stderr: redact(e.stderr ?? String(err), secret),
      code: typeof e.code === "number" ? e.code : 1,
      timedOut: Boolean(e.killed),
    };
  }
}

export interface CheckoutOptions {
  owner: string;
  repo: string;
  /** Stable directory key (e.g. `issue-42`) so re-drives reuse the checkout. */
  key: string;
  token: string;
  /** Branch/ref to check out after clone (defaults to the repo default). */
  ref?: string;
}

export class WorkspaceManager {
  private readonly authorName = process.env.GIT_AUTHOR_NAME ?? "render-agent";
  private readonly authorEmail =
    process.env.GIT_AUTHOR_EMAIL ?? "render-agent@users.noreply.github.com";

  dirFor(key: string): string {
    return path.join(workspaceRoot(), key);
  }

  private async isGitRepo(dir: string): Promise<boolean> {
    try {
      await fs.access(path.join(dir, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /** Clone if the checkout is missing; otherwise reuse it. Idempotent. */
  async ensureCheckout(opts: CheckoutOptions): Promise<string> {
    const dir = this.dirFor(opts.key);
    if (await this.isGitRepo(dir)) return dir;

    await fs.mkdir(path.dirname(dir), { recursive: true });
    const url = `https://x-access-token:${opts.token}@github.com/${opts.owner}/${opts.repo}.git`;
    const clone = await runGit(path.dirname(dir), ["clone", url, path.basename(dir)], opts.token);
    if (clone.code !== 0) throw new Error(`git clone failed: ${clone.stderr}`);

    if (opts.ref) {
      const co = await runGit(dir, ["checkout", opts.ref], opts.token);
      if (co.code !== 0) throw new Error(`git checkout ${opts.ref} failed: ${co.stderr}`);
    }
    await runGit(dir, ["config", "user.name", this.authorName]);
    await runGit(dir, ["config", "user.email", this.authorEmail]);
    return dir;
  }

  /** Create (or reset) a working branch off the current HEAD. */
  async createBranch(dir: string, branch: string): Promise<void> {
    const r = await runGit(dir, ["checkout", "-B", branch]);
    if (r.code !== 0) throw new Error(`git checkout -B ${branch} failed: ${r.stderr}`);
  }

  async hasChanges(dir: string): Promise<boolean> {
    const r = await runGit(dir, ["status", "--porcelain"]);
    return r.stdout.trim().length > 0;
  }

  /** Stage everything and commit; returns false if there was nothing to commit. */
  async commitAll(dir: string, message: string): Promise<boolean> {
    await runGit(dir, ["add", "-A"]);
    const staged = await runGit(dir, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) return false; // exit 0 => no staged changes
    const commit = await runGit(dir, ["commit", "-m", message]);
    if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
    return true;
  }

  async push(dir: string, branch: string): Promise<void> {
    const r = await runGit(dir, ["push", "--force-with-lease", "origin", branch]);
    if (r.code !== 0) throw new Error(`git push failed: ${r.stderr}`);
  }

  async diffStat(dir: string): Promise<string> {
    const r = await runGit(dir, ["--no-pager", "diff", "--stat", "HEAD~1..HEAD"]);
    return r.stdout.trim();
  }

  async cleanup(key: string): Promise<void> {
    await fs.rm(this.dirFor(key), { recursive: true, force: true }).catch(() => {});
  }
}
