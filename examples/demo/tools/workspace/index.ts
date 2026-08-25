import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { DefineToolSpec } from "@render-factory/sdk";
import { resolveWithinRoot, runShell } from "../../src/lib/workspace.js";

// Model-facing filesystem + shell tools (mounted as workspace__exec,
// workspace__read_file, …). They operate on the run's checkout, confined under
// the workspace root so a tool call can't read/write outside it. This is a
// trusted-repo demo substrate (child_process), not a hardened sandbox — the
// guardrails are: path confinement, a command denylist, an exec timeout, and an
// output cap. Swap in a real sandbox (MCP/E2B) for untrusted code.

const MAX_OUTPUT = 20_000;
const MAX_FILE = 100_000;

// Obvious footguns. child_process runs via /bin/sh, so this is a guardrail, not
// a security boundary — see the note above.
const DENY = [/\bsudo\b/, /\brm\s+-rf\s+\/(?!\w)/, /\bmkfs\b/, /\bshutdown\b/, /\breboot\b/, /:\(\)\s*\{/];

function truncate(s: string, n = MAX_OUTPUT): string {
  return s.length > n ? `${s.slice(0, n)}\n… [truncated ${s.length - n} chars]` : s;
}

const exec: DefineToolSpec = {
  name: "exec",
  description:
    "Run a shell command inside the checked-out repository (for builds, tests, " +
    "git status/diff, grep, etc.). Returns combined stdout/stderr and the exit code. " +
    "A non-zero exit is normal output (e.g. failing tests), not a tool error.",
  inputSchema: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "The command to run, e.g. `npm test`." },
      cwd: { type: "string", description: "Working directory (repo checkout path). Defaults to the workspace root." },
      timeoutMs: { type: "number", description: "Timeout in ms (default 120000, max 600000)." },
    },
    required: ["cmd"],
  },
  async invoke(input) {
    const { cmd, cwd, timeoutMs } = (input ?? {}) as { cmd: string; cwd?: string; timeoutMs?: number };
    if (!cmd || typeof cmd !== "string") return { content: "exec: `cmd` is required", isError: true };
    if (DENY.some((re) => re.test(cmd))) return { content: `exec: command blocked by policy: ${cmd}`, isError: true };

    let dir: string;
    try {
      dir = cwd ? resolveWithinRoot(cwd) : resolveWithinRoot(".");
    } catch (err) {
      return { content: String(err instanceof Error ? err.message : err), isError: true };
    }

    const r = await runShell(cmd, { cwd: dir, timeoutMs });
    if (r.timedOut) return { content: `exec: timed out after ${timeoutMs ?? 120000}ms\n${truncate(r.stdout)}`, isError: true };
    const body = [
      `$ ${cmd}`,
      `exit: ${r.code}`,
      r.stdout.trim() ? `--- stdout ---\n${truncate(r.stdout)}` : "",
      r.stderr.trim() ? `--- stderr ---\n${truncate(r.stderr)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return body;
  },
};

const readFile: DefineToolSpec = {
  name: "read_file",
  description: "Read a UTF-8 file from the checkout. Returns its contents (truncated if very large).",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "File path within the checkout." } },
    required: ["path"],
  },
  async invoke(input) {
    const { path: p } = (input ?? {}) as { path: string };
    try {
      const abs = resolveWithinRoot(p);
      const content = await fs.readFile(abs, "utf8");
      return truncate(content, MAX_FILE);
    } catch (err) {
      return { content: `read_file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

const writeFile: DefineToolSpec = {
  name: "write_file",
  description: "Create or overwrite a UTF-8 file in the checkout (parent directories are created).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path within the checkout." },
      content: { type: "string", description: "Full file contents to write." },
    },
    required: ["path", "content"],
  },
  async invoke(input) {
    const { path: p, content } = (input ?? {}) as { path: string; content: string };
    try {
      const abs = resolveWithinRoot(p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content ?? "", "utf8");
      return `Wrote ${Buffer.byteLength(content ?? "")} bytes to ${p}`;
    } catch (err) {
      return { content: `write_file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

const applyPatch: DefineToolSpec = {
  name: "apply_patch",
  description: "Apply a unified diff (git apply) to the checkout. Prefer this for multi-file edits.",
  inputSchema: {
    type: "object",
    properties: {
      diff: { type: "string", description: "A unified diff in `git apply` format." },
      cwd: { type: "string", description: "Repo checkout path. Defaults to the workspace root." },
    },
    required: ["diff"],
  },
  async invoke(input) {
    const { diff, cwd } = (input ?? {}) as { diff: string; cwd?: string };
    try {
      const dir = cwd ? resolveWithinRoot(cwd) : resolveWithinRoot(".");
      const patchFile = path.join(dir, ".render-agent.patch");
      await fs.writeFile(patchFile, diff, "utf8");
      const r = await runShell("git apply --whitespace=nowarn .render-agent.patch", { cwd: dir });
      await fs.rm(patchFile, { force: true });
      if (r.code !== 0) return { content: `apply_patch failed:\n${truncate(r.stderr)}`, isError: true };
      return "Patch applied.";
    } catch (err) {
      return { content: `apply_patch: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

const listDir: DefineToolSpec = {
  name: "list_dir",
  description: "List the entries in a directory within the checkout (directories end with '/').",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path. Defaults to the workspace root." } },
    required: [],
  },
  async invoke(input) {
    const { path: p } = (input ?? {}) as { path?: string };
    try {
      const abs = resolveWithinRoot(p ?? ".");
      const entries = await fs.readdir(abs, { withFileTypes: true });
      if (entries.length === 0) return "(empty)";
      return entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .join("\n");
    } catch (err) {
      return { content: `list_dir: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

const tools: DefineToolSpec[] = [exec, readFile, writeFile, applyPatch, listDir];
export default tools;
