import type { Readable } from "node:stream";

/**
 * Output events streamed from a sandbox command execution.
 */
export type SandboxExecEvent =
  | { type: "output"; stream: "stdout" | "stderr"; data: string }
  | { type: "exit"; exitCode: number };

/**
 * Result of downloading a file from a sandbox.
 */
export interface SandboxDownload {
  data: Buffer;
  size: number;
  contentType: string;
}

/**
 * Options for creating a new sandbox instance.
 */
export interface CreateSandboxOptions {
  /** Maximum lifetime in seconds before auto-termination. */
  timeoutSeconds?: number;
  /** Metadata to associate with the sandbox. */
  metadata?: Record<string, string>;
}

/**
 * Options for executing a command in the sandbox.
 */
export interface SandboxExecOptions {
  signal?: AbortSignal;
}

/**
 * Options for uploading data to the sandbox.
 */
export interface SandboxUploadOptions {
  /** MIME type of the upload. Use "application/x-tar" for directory trees. */
  contentType?: string;
}

export type SandboxUploadData = Buffer | Uint8Array | string | Readable;

export type SandboxStatus = "pending" | "running" | "errored" | "terminated";

/**
 * A live sandbox session. Represents an isolated execution environment
 * with filesystem and shell access. The low-level primitives (exec, upload,
 * download) are the provider contract; structured file ops (readFile, writeFile,
 * listDir) have default implementations built on those primitives.
 */
export interface Sandbox {
  readonly id: string;

  // --- Low-level primitives (provider must implement) ---

  /** Execute a shell command. Returns an async generator of output events. */
  exec(command: string, opts?: SandboxExecOptions): Promise<AsyncGenerator<SandboxExecEvent>>;

  /** Upload a file or directory (tar) to the sandbox. */
  upload(path: string, data: SandboxUploadData, opts?: SandboxUploadOptions): Promise<void>;

  /** Download a file from the sandbox. */
  download(path: string): Promise<SandboxDownload>;

  /** Get current status. */
  status(): Promise<SandboxStatus>;

  /** Terminate the sandbox and release resources. */
  terminate(): Promise<void>;

  // --- Structured file ops (defaults use exec/upload/download) ---

  /** Read a UTF-8 file from the sandbox. */
  readFile(path: string): Promise<string>;

  /** Write a UTF-8 file to the sandbox (creates parent dirs). */
  writeFile(path: string, content: string): Promise<void>;

  /** List entries in a directory. Returns filenames (dirs end with '/'). */
  listDir(path: string): Promise<string[]>;
}

/**
 * Factory for creating and reconnecting to sandboxes. Implementations wrap a
 * specific backend (Render Sandboxes, E2B, Docker, etc.).
 */
export interface SandboxProvider {
  readonly name: string;

  /** Create and wait for a sandbox to reach "running" state. */
  create(opts?: CreateSandboxOptions): Promise<Sandbox>;

  /** Reconnect to an already-running sandbox by ID (for cross-container reattachment). */
  connect(sandboxId: string): Promise<Sandbox>;
}

// ---------------------------------------------------------------------------
// BaseSandbox — abstract class with default readFile/writeFile/listDir
// ---------------------------------------------------------------------------

/**
 * Collect all output from an exec generator into a single string.
 */
export async function collectExecOutput(
  events: AsyncGenerator<SandboxExecEvent>,
): Promise<{ output: string; exitCode: number }> {
  const chunks: string[] = [];
  let exitCode = -1;
  for await (const event of events) {
    if (event.type === "output") chunks.push(event.data);
    else if (event.type === "exit") exitCode = event.exitCode;
  }
  return { output: chunks.join(""), exitCode };
}

/**
 * Abstract base class for sandbox providers. Implements readFile, writeFile,
 * and listDir on top of the exec/upload/download primitives. Providers extend
 * this and only implement the abstract methods.
 */
export abstract class BaseSandbox implements Sandbox {
  abstract readonly id: string;
  abstract exec(command: string, opts?: SandboxExecOptions): Promise<AsyncGenerator<SandboxExecEvent>>;
  abstract upload(path: string, data: SandboxUploadData, opts?: SandboxUploadOptions): Promise<void>;
  abstract download(path: string): Promise<SandboxDownload>;
  abstract status(): Promise<SandboxStatus>;
  abstract terminate(): Promise<void>;

  async readFile(path: string): Promise<string> {
    const escaped = shellEscape(path);
    const events = await this.exec(`cat ${escaped}`);
    const { output, exitCode } = await collectExecOutput(events);
    if (exitCode !== 0) throw new Error(`readFile failed (exit ${exitCode}): ${output.slice(0, 200)}`);
    return output;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    if (dir) {
      const mkdirEvents = await this.exec(`mkdir -p ${shellEscape(dir)}`);
      await collectExecOutput(mkdirEvents);
    }
    await this.upload(path, content);
  }

  async listDir(path: string): Promise<string[]> {
    const escaped = shellEscape(path);
    const events = await this.exec(`ls -1F ${escaped}`);
    const { output, exitCode } = await collectExecOutput(events);
    if (exitCode !== 0) throw new Error(`listDir failed (exit ${exitCode}): ${output.slice(0, 200)}`);
    return output.split("\n").filter(Boolean);
  }
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
