import type { Readable } from "node:stream";

// --- Types ---

export type SandboxExecEvent =
  | { type: "output"; stream: "stdout" | "stderr"; data: string }
  | { type: "exit"; exitCode: number };

export interface SandboxDownload {
  data: Buffer;
  size: number;
  contentType: string;
}

export interface CreateSandboxOptions {
  /** Maximum lifetime in seconds before auto-termination. */
  timeoutSeconds?: number;
  /** Metadata to associate with the sandbox. */
  metadata?: Record<string, string>;
}

export interface SandboxExecOptions {
  signal?: AbortSignal;
}

export interface SandboxUploadOptions {
  /** MIME type of the upload. Use "application/x-tar" for directory trees. */
  contentType?: string;
}

export type SandboxUploadData = Buffer | Uint8Array | string | Readable;

export type SandboxStatus = "pending" | "running" | "errored" | "terminated";

// --- Sandbox Interface ---

/**
 * A live sandbox session: isolated environment with filesystem and shell access.
 * Low-level primitives (exec, upload, download) are the provider contract;
 * structured file ops have defaults built on those primitives.
 */
export interface Sandbox {
  readonly id: string;

  exec(command: string, opts?: SandboxExecOptions): Promise<AsyncGenerator<SandboxExecEvent>>;
  upload(path: string, data: SandboxUploadData, opts?: SandboxUploadOptions): Promise<void>;
  download(path: string): Promise<SandboxDownload>;
  status(): Promise<SandboxStatus>;
  terminate(): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
}

// --- Provider Interface ---

/**
 * Factory for sandbox instances. Implementations wrap a specific backend
 * (Render Sandboxes, E2B, Docker, etc.).
 */
export interface SandboxProvider {
  readonly name: string;

  create(opts?: CreateSandboxOptions): Promise<Sandbox>;
  connect(sandboxId: string): Promise<Sandbox>;
}

// --- Base Implementation ---

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
 * Abstract base: readFile/writeFile/listDir built on exec/upload/download.
 * Providers extend this and only implement the abstract methods.
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
