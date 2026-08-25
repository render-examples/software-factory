import type { ToolResult } from "@render-factory/store";
import type { Tool, ToolSource, ResolvedSource, ToolContext, Environment } from "./tool.js";
import type { Sandbox, SandboxProvider } from "./sandbox.js";
import { collectExecOutput } from "./sandbox.js";

export interface SandboxToolSourceOptions {
  /** Provider used to connect to sandboxes by ID. */
  provider: SandboxProvider;
  /** Source ID used for namespacing. Default: "sandbox". */
  id?: string;
}

/**
 * Creates a ToolSource where every tool call takes an explicit `sandbox_id`
 * parameter. The tool source maintains a connection cache keyed by sandbox ID
 * so repeated calls to the same sandbox reuse the connection. This enables an
 * agent to work across multiple sandboxes in a single run.
 *
 * Lifecycle: the tool source does NOT terminate sandboxes on close — the
 * caller (workflow/gateway) owns creation and teardown.
 */
export function createSandboxToolSource(opts: SandboxToolSourceOptions): ToolSource {
  const sourceId = opts.id ?? "sandbox";
  const { provider } = opts;
  const cache = new Map<string, Sandbox>();

  async function resolve(sandboxId: string): Promise<Sandbox> {
    let sandbox = cache.get(sandboxId);
    if (sandbox) return sandbox;
    sandbox = await provider.connect(sandboxId);
    cache.set(sandboxId, sandbox);
    return sandbox;
  }

  return {
    id: sourceId,
    async resolve(_env: Environment): Promise<ResolvedSource> {
      const tools: Tool[] = [
        buildExecTool(resolve),
        buildReadFileTool(resolve),
        buildWriteFileTool(resolve),
        buildListDirTool(resolve),
        buildApplyPatchTool(resolve),
        buildSearchTool(resolve),
      ];

      return {
        tools,
        prefixTools: true,
        async close() {
          cache.clear();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type Resolver = (sandboxId: string) => Promise<Sandbox>;

const SANDBOX_ID_PROP = {
  sandbox_id: { type: "string", description: "Target sandbox ID." },
} as const;

const MAX_OUTPUT_CHARS = 50_000;

function truncate(s: string, limit = MAX_OUTPUT_CHARS): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n... (truncated, ${s.length - limit} chars omitted)`;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function buildExecTool(resolve: Resolver): Tool {
  return {
    name: "exec",
    description:
      "Execute a shell command in a sandbox. Returns combined stdout/stderr and the exit code. " +
      "A non-zero exit code is normal output (e.g. failing tests), not a tool error.",
    inputSchema: {
      type: "object",
      properties: {
        ...SANDBOX_ID_PROP,
        command: { type: "string", description: "The shell command to execute." },
        cwd: { type: "string", description: "Working directory. Optional." },
      },
      required: ["sandbox_id", "command"],
    },
    async invoke(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { sandbox_id, command, cwd } = input as { sandbox_id: string; command: string; cwd?: string };
      const sandbox = await resolve(sandbox_id);
      const cmd = cwd ? `cd ${shellEscape(cwd)} && ${command}` : command;
      const events = await sandbox.exec(cmd, { signal: ctx.signal });
      const { output, exitCode } = await collectExecOutput(events);
      const body = truncate(output) || "(no output)";
      return { content: exitCode === 0 ? body : `Exit code: ${exitCode}\n${body}`, isError: exitCode !== 0 };
    },
  };
}

function buildReadFileTool(resolve: Resolver): Tool {
  return {
    name: "read_file",
    description: "Read a UTF-8 file from a sandbox. Returns its contents.",
    inputSchema: {
      type: "object",
      properties: {
        ...SANDBOX_ID_PROP,
        path: { type: "string", description: "File path within the sandbox." },
      },
      required: ["sandbox_id", "path"],
    },
    async invoke(input: unknown): Promise<ToolResult> {
      const { sandbox_id, path } = input as { sandbox_id: string; path: string };
      const sandbox = await resolve(sandbox_id);
      const content = await sandbox.readFile(path);
      return { content: truncate(content, 100_000) };
    },
  };
}

function buildWriteFileTool(resolve: Resolver): Tool {
  return {
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 file in a sandbox. Parent directories are created automatically.",
    inputSchema: {
      type: "object",
      properties: {
        ...SANDBOX_ID_PROP,
        path: { type: "string", description: "File path within the sandbox." },
        content: { type: "string", description: "Full file contents to write." },
      },
      required: ["sandbox_id", "path", "content"],
    },
    async invoke(input: unknown): Promise<ToolResult> {
      const { sandbox_id, path, content } = input as { sandbox_id: string; path: string; content: string };
      const sandbox = await resolve(sandbox_id);
      await sandbox.writeFile(path, content);
      return { content: `Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${path}` };
    },
  };
}

function buildListDirTool(resolve: Resolver): Tool {
  return {
    name: "list_dir",
    description:
      "List entries in a directory. Directories are suffixed with '/'. Defaults to the sandbox root.",
    inputSchema: {
      type: "object",
      properties: {
        ...SANDBOX_ID_PROP,
        path: { type: "string", description: "Directory path. Defaults to '.'." },
      },
      required: ["sandbox_id"],
    },
    async invoke(input: unknown): Promise<ToolResult> {
      const { sandbox_id, path } = (input ?? {}) as { sandbox_id: string; path?: string };
      const sandbox = await resolve(sandbox_id);
      const entries = await sandbox.listDir(path || ".");
      return { content: entries.join("\n") || "(empty directory)" };
    },
  };
}

function buildApplyPatchTool(resolve: Resolver): Tool {
  return {
    name: "apply_patch",
    description:
      "Apply a unified diff (git apply format) to files in a sandbox. Prefer this for multi-file edits.",
    inputSchema: {
      type: "object",
      properties: {
        ...SANDBOX_ID_PROP,
        diff: { type: "string", description: "A unified diff in `git apply` format." },
        cwd: { type: "string", description: "Working directory for the patch. Optional." },
      },
      required: ["sandbox_id", "diff"],
    },
    async invoke(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { sandbox_id, diff, cwd } = input as { sandbox_id: string; diff: string; cwd?: string };
      const sandbox = await resolve(sandbox_id);
      const patchPath = "/tmp/.render-agent.patch";
      await sandbox.upload(patchPath, diff);
      const cdPrefix = cwd ? `cd ${shellEscape(cwd)} && ` : "";
      const events = await sandbox.exec(
        `${cdPrefix}git apply --whitespace=nowarn ${patchPath} && rm ${patchPath}`,
        { signal: ctx.signal },
      );
      const { output, exitCode } = await collectExecOutput(events);
      if (exitCode !== 0) return { content: `Patch failed (exit ${exitCode}):\n${truncate(output)}`, isError: true };
      return { content: "Patch applied successfully." };
    },
  };
}

function buildSearchTool(resolve: Resolver): Tool {
  return {
    name: "search",
    description:
      "Search file contents using ripgrep (rg). Returns matching lines with file paths and line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        ...SANDBOX_ID_PROP,
        pattern: { type: "string", description: "Regex pattern to search for." },
        path: { type: "string", description: "Directory or file to search. Defaults to '.'." },
        include: { type: "string", description: "Glob to filter files (e.g. '*.ts'). Optional." },
      },
      required: ["sandbox_id", "pattern"],
    },
    async invoke(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { sandbox_id, pattern, path, include } = input as { sandbox_id: string; pattern: string; path?: string; include?: string };
      const sandbox = await resolve(sandbox_id);
      const args = ["rg", "--line-number", "--no-heading"];
      if (include) args.push("--glob", include);
      args.push("--", pattern, path || ".");
      const events = await sandbox.exec(args.map(shellEscape).join(" "), { signal: ctx.signal });
      const { output, exitCode } = await collectExecOutput(events);
      if (exitCode === 1) return { content: "(no matches)" };
      if (exitCode > 1) return { content: `Search failed (exit ${exitCode}):\n${truncate(output)}`, isError: true };
      return { content: truncate(output) };
    },
  };
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
