/**
 * Sandbox — provider-agnostic interfaces for isolated execution environments.
 * Workflows own lifecycle (create/terminate); agents use sandbox__* tools.
 */
import type { Readable } from "node:stream";

export type SandboxExecEvent =
  | { type: "output"; stream: "stdout" | "stderr"; data: string }
  | { type: "exit"; exitCode: number };

export type SandboxStatus = "pending" | "running" | "errored" | "terminated";

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

export interface SandboxProvider {
  readonly name: string;
  create(opts?: CreateSandboxOptions): Promise<Sandbox>;
  connect(sandboxId: string): Promise<Sandbox>;
}
