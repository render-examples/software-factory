/**
 * BaseSandbox — abstract base with file ops built on exec/upload/download.
 * collectExecOutput and shellEscape are shared utilities.
 */
import type {
  Sandbox,
  SandboxExecEvent,
  SandboxExecOptions,
  SandboxDownload,
  SandboxUploadData,
  SandboxUploadOptions,
} from "./types.js";

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
  abstract status(): Promise<import("./types.js").SandboxStatus>;
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

const MAX_COLLECT_CHARS = 1_000_000;

/** Collect exec output into a single string. Caps at 1 MB. */
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
  return `'${s.replace(/'/g, "'\\''")}'`;
}
