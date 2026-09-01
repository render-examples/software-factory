/**
 * Sandbox tools — agent-visible sandbox operations (sandbox__*).
 *
 * Tools are module-level values. Call `configureSandboxProvider()` once at
 * startup before any tool is invoked; the provider is captured lazily so
 * agent definitions can import tools at module parse time.
 */
import { z } from "zod";
import type { Tool, ToolResult, ToolContext } from "./tools.js";
import type { Sandbox, SandboxProvider } from "./sandbox/index.js";
import { collectExecOutput, shellEscape } from "./sandbox/index.js";

// ---------------------------------------------------------------------------
// Provider binding — set once at startup
// ---------------------------------------------------------------------------

let _provider: SandboxProvider | undefined;

export function configureSandboxProvider(provider: SandboxProvider): void {
  _provider = provider;
}

async function resolveSandbox(ctx: ToolContext): Promise<Sandbox> {
  if (!_provider) {
    throw new Error(
      "Sandbox provider not configured — call configureSandboxProvider() at startup",
    );
  }
  if (!ctx.sandboxId) {
    throw new Error(`Agent "${ctx.agentId}" has no sandbox binding`);
  }
  return _provider.connect(ctx.sandboxId);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Resolver = (ctx: ToolContext) => Promise<Sandbox>;

const MAX_OUTPUT_CHARS = 50_000;

function truncate(s: string, limit = MAX_OUTPUT_CHARS): string {
  if (s.length <= limit) return s;
  return (
    s.slice(0, limit) +
    `\n... (truncated, ${s.length - limit} chars omitted)`
  );
}

let patchCounter = 0;
function uniquePatchPath(): string {
  return `/tmp/.render-agent-${Date.now()}-${++patchCounter}.patch`;
}

// ---------------------------------------------------------------------------
// Tool builders (unchanged logic, now using the shared resolver)
// ---------------------------------------------------------------------------

const execSchema = {
  command: z.string().describe("The shell command to execute."),
  cwd: z.string().optional().describe("Working directory. Optional."),
};

function buildExecTool(resolve: Resolver): Tool<typeof execSchema> {
  return {
    name: "sandbox__exec",
    description:
      "Execute a shell command in a sandbox. Returns combined stdout/stderr and the exit code. " +
      "A non-zero exit code is normal output (e.g. failing tests), not a tool error.",
    inputSchema: execSchema,
    async invoke(input, ctx: ToolContext): Promise<ToolResult> {
      const sandbox = await resolve(ctx);
      const cmd = input.cwd
        ? `cd ${shellEscape(input.cwd)} && ${input.command}`
        : input.command;
      const events = await sandbox.exec(cmd, { signal: ctx.signal });
      const { output, exitCode } = await collectExecOutput(events);
      const body = truncate(output) || "(no output)";
      return {
        content:
          exitCode === 0 ? body : `Exit code: ${exitCode}\n${body}`,
        isError: exitCode !== 0,
      };
    },
  };
}

const readFileSchema = {
  path: z.string().describe("File path within the sandbox."),
};

function buildReadFileTool(resolve: Resolver): Tool<typeof readFileSchema> {
  return {
    name: "sandbox__read_file",
    description: "Read a UTF-8 file from a sandbox. Returns its contents.",
    inputSchema: readFileSchema,
    async invoke(input, ctx): Promise<ToolResult> {
      const sandbox = await resolve(ctx);
      const content = await sandbox.readFile(input.path);
      return { content: truncate(content, 100_000) };
    },
  };
}

const writeFileSchema = {
  path: z.string().describe("File path within the sandbox."),
  content: z.string().describe("Full file contents to write."),
};

function buildWriteFileTool(resolve: Resolver): Tool<typeof writeFileSchema> {
  return {
    name: "sandbox__write_file",
    description:
      "Create or overwrite a UTF-8 file in a sandbox. Parent directories are created automatically.",
    inputSchema: writeFileSchema,
    async invoke(input, ctx): Promise<ToolResult> {
      const sandbox = await resolve(ctx);
      await sandbox.writeFile(input.path, input.content);
      return {
        content: `Wrote ${Buffer.byteLength(input.content, "utf-8")} bytes to ${input.path}`,
      };
    },
  };
}

const listDirSchema = {
  path: z
    .string()
    .optional()
    .describe("Directory path. Defaults to '.'."),
};

function buildListDirTool(resolve: Resolver): Tool<typeof listDirSchema> {
  return {
    name: "sandbox__list_dir",
    description:
      "List entries in a directory. Directories are suffixed with '/'. Defaults to the sandbox root.",
    inputSchema: listDirSchema,
    async invoke(input, ctx): Promise<ToolResult> {
      const sandbox = await resolve(ctx);
      const entries = await sandbox.listDir(input.path || ".");
      return { content: entries.join("\n") || "(empty directory)" };
    },
  };
}

const applyPatchSchema = {
  diff: z.string().describe("A unified diff in `git apply` format."),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the patch. Optional."),
};

function buildApplyPatchTool(
  resolve: Resolver,
): Tool<typeof applyPatchSchema> {
  return {
    name: "sandbox__apply_patch",
    description:
      "Apply a unified diff (git apply format) to files in a sandbox. Prefer this for multi-file edits.",
    inputSchema: applyPatchSchema,
    async invoke(input, ctx: ToolContext): Promise<ToolResult> {
      const sandbox = await resolve(ctx);
      const patchPath = uniquePatchPath();
      await sandbox.upload(patchPath, input.diff);
      const cdPrefix = input.cwd
        ? `cd ${shellEscape(input.cwd)} && `
        : "";
      const events = await sandbox.exec(
        `${cdPrefix}git apply --whitespace=nowarn ${patchPath} && rm ${patchPath}`,
        { signal: ctx.signal },
      );
      const { output, exitCode } = await collectExecOutput(events);
      if (exitCode !== 0) {
        return {
          content: `Patch failed (exit ${exitCode}):\n${truncate(output)}`,
          isError: true,
        };
      }
      return { content: "Patch applied successfully." };
    },
  };
}

const searchSchema = {
  pattern: z.string().describe("Regex pattern to search for."),
  path: z
    .string()
    .optional()
    .describe("Directory or file to search. Defaults to '.'."),
  include: z
    .string()
    .optional()
    .describe("Glob to filter files (e.g. '*.ts'). Optional."),
};

function buildSearchTool(resolve: Resolver): Tool<typeof searchSchema> {
  return {
    name: "sandbox__search",
    description:
      "Search file contents using ripgrep (rg). Returns matching lines with file paths and line numbers.",
    inputSchema: searchSchema,
    async invoke(input, ctx: ToolContext): Promise<ToolResult> {
      const sandbox = await resolve(ctx);
      const args = ["rg", "--line-number", "--no-heading"];
      if (input.include) args.push("--glob", input.include);
      args.push("--", input.pattern, input.path || ".");
      const events = await sandbox.exec(
        args.map(shellEscape).join(" "),
        { signal: ctx.signal },
      );
      const { output, exitCode } = await collectExecOutput(events);
      if (exitCode === 1) return { content: "(no matches)" };
      if (exitCode > 1) {
        return {
          content: `Search failed (exit ${exitCode}):\n${truncate(output)}`,
          isError: true,
        };
      }
      return { content: truncate(output) };
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level tool instances
// ---------------------------------------------------------------------------

export const sandboxExec = buildExecTool(resolveSandbox);
export const sandboxReadFile = buildReadFileTool(resolveSandbox);
export const sandboxWriteFile = buildWriteFileTool(resolveSandbox);
export const sandboxListDir = buildListDirTool(resolveSandbox);
export const sandboxApplyPatch = buildApplyPatchTool(resolveSandbox);
export const sandboxSearch = buildSearchTool(resolveSandbox);

/** All sandbox tools as an array, for convenience. */
export const allSandboxTools: readonly Tool[] = [
  sandboxExec,
  sandboxReadFile,
  sandboxWriteFile,
  sandboxListDir,
  sandboxApplyPatch,
  sandboxSearch,
];

// ---------------------------------------------------------------------------
// Test support — create sandbox tools bound to a specific provider
// ---------------------------------------------------------------------------

export function createSandboxToolsForProvider(provider: SandboxProvider) {
  const resolve: Resolver = async (ctx) => {
    if (!ctx.sandboxId) {
      throw new Error(`Agent "${ctx.agentId}" has no sandbox binding`);
    }
    return provider.connect(ctx.sandboxId);
  };
  return {
    exec: buildExecTool(resolve),
    readFile: buildReadFileTool(resolve),
    writeFile: buildWriteFileTool(resolve),
    listDir: buildListDirTool(resolve),
    applyPatch: buildApplyPatchTool(resolve),
    search: buildSearchTool(resolve),
    all(): Tool[] {
      return [this.exec, this.readFile, this.writeFile, this.listDir, this.applyPatch, this.search];
    },
  };
}
