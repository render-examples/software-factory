/**
 * SandboxToolSource — exposes sandbox operations as agent tools (sandbox__*).
 * The workflow binds one sandbox ID through ToolContext. The model cannot
 * select or address another run's sandbox.
 */
import { z } from "zod";
import type { Tool, ToolSource, ToolResult, ToolContext } from "./tools.js";
import type { Sandbox, SandboxProvider } from "./sandbox.js";
import { collectExecOutput, shellEscape } from "./sandbox.js";

export interface SandboxToolSourceOptions {
  provider: SandboxProvider;
  id?: string;
}

const MAX_OUTPUT_CHARS = 50_000;

function truncate(s: string, limit = MAX_OUTPUT_CHARS): string {
  if (s.length <= limit) return s;
  return (
    s.slice(0, limit) +
    `\n... (truncated, ${s.length - limit} chars omitted)`
  );
}

export function createSandboxToolSource(
  opts: SandboxToolSourceOptions,
): ToolSource {
  const sourceId = opts.id ?? "sandbox";
  const { provider } = opts;

  async function resolve(ctx: ToolContext): Promise<Sandbox> {
    if (!ctx.sandboxId) {
      throw new Error(`Agent "${ctx.agentId}" has no sandbox binding`);
    }
    return provider.connect(ctx.sandboxId);
  }

  return {
    id: sourceId,
    resolve(): Tool[] {
      return [
        buildExecTool(resolve),
        buildReadFileTool(resolve),
        buildWriteFileTool(resolve),
        buildListDirTool(resolve),
        buildApplyPatchTool(resolve),
        buildSearchTool(resolve),
      ];
    },
  };
}

type Resolver = (ctx: ToolContext) => Promise<Sandbox>;

let patchCounter = 0;
function uniquePatchPath(): string {
  return `/tmp/.render-agent-${Date.now()}-${++patchCounter}.patch`;
}

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
