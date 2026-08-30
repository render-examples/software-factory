/**
 * Sandbox — provider-agnostic interfaces for isolated execution environments.
 *
 * Sandboxes give agents a remote filesystem and shell. Workflows own the
 * lifecycle (create/terminate); agents consume via sandbox__* tools.
 *
 * No SDK imports — provider implementations live in sdk/sandbox/.
 */
import type { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Event / status types
// ---------------------------------------------------------------------------

export type SandboxExecEvent =
  | { type: "output"; stream: "stdout" | "stderr"; data: string }
  | { type: "exit"; exitCode: number };

export type SandboxStatus = "pending" | "running" | "errored" | "terminated";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateSandboxOptions {
  timeoutSeconds?: number;
  metadata?: Record<string, string>;
}

export interface SandboxExecOptions {
  signal?: AbortSignal;
}

export interface SandboxUploadOptions {
  contentType?: string;
}

export type SandboxUploadData = Buffer | Uint8Array | string | Readable;

export interface SandboxDownload {
  data: Buffer;
  size: number;
  contentType: string;
}

// ---------------------------------------------------------------------------
// Sandbox — a live session with filesystem and shell access
// ---------------------------------------------------------------------------

export interface Sandbox {
  readonly id: string;

  exec(
    command: string,
    opts?: SandboxExecOptions,
  ): Promise<AsyncGenerator<SandboxExecEvent>>;

  upload(
    path: string,
    data: SandboxUploadData,
    opts?: SandboxUploadOptions,
  ): Promise<void>;

  download(path: string): Promise<SandboxDownload>;
  status(): Promise<SandboxStatus>;
  terminate(): Promise<void>;

  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// SandboxProvider — factory for sandbox instances
// ---------------------------------------------------------------------------

export interface SandboxProvider {
  readonly name: string;
  create(opts?: CreateSandboxOptions): Promise<Sandbox>;
  connect(sandboxId: string): Promise<Sandbox>;
}

// ---------------------------------------------------------------------------
// BaseSandbox — abstract base with file ops built on exec/upload/download
// ---------------------------------------------------------------------------

export abstract class BaseSandbox implements Sandbox {
  abstract readonly id: string;

  abstract exec(
    command: string,
    opts?: SandboxExecOptions,
  ): Promise<AsyncGenerator<SandboxExecEvent>>;

  abstract upload(
    path: string,
    data: SandboxUploadData,
    opts?: SandboxUploadOptions,
  ): Promise<void>;

  abstract download(path: string): Promise<SandboxDownload>;
  abstract status(): Promise<SandboxStatus>;
  abstract terminate(): Promise<void>;

  async readFile(path: string): Promise<string> {
    const events = await this.exec(`cat ${shellEscape(path)}`);
    const { output, exitCode } = await collectExecOutput(events);
    if (exitCode !== 0) {
      throw new Error(
        `readFile failed (exit ${exitCode}): ${output.slice(0, 200)}`,
      );
    }
    return output;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const dir =
      path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    if (dir) {
      const mkdirEvents = await this.exec(
        `mkdir -p ${shellEscape(dir)}`,
      );
      await collectExecOutput(mkdirEvents);
    }
    await this.upload(path, content);
  }

  async listDir(path: string): Promise<string[]> {
    const events = await this.exec(`ls -1F ${shellEscape(path)}`);
    const { output, exitCode } = await collectExecOutput(events);
    if (exitCode !== 0) {
      throw new Error(
        `listDir failed (exit ${exitCode}): ${output.slice(0, 200)}`,
      );
    }
    return output.split("\n").filter(Boolean);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_COLLECT_CHARS = 1_000_000;

/**
 * Collect exec output into a single string. Caps buffered output at 1MB
 * to prevent unbounded memory growth from long-running commands.
 */
export async function collectExecOutput(
  events: AsyncGenerator<SandboxExecEvent>,
): Promise<{ output: string; exitCode: number }> {
  const chunks: string[] = [];
  let totalLen = 0;
  let exitCode = -1;

  for await (const event of events) {
    if (event.type === "output") {
      if (totalLen < MAX_COLLECT_CHARS) {
        const remaining = MAX_COLLECT_CHARS - totalLen;
        const chunk =
          event.data.length > remaining
            ? event.data.slice(0, remaining)
            : event.data;
        chunks.push(chunk);
        totalLen += chunk.length;
      }
    } else if (event.type === "exit") {
      exitCode = event.exitCode;
    }
  }

  return { output: chunks.join(""), exitCode };
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
