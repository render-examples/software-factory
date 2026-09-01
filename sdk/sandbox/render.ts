/**
 * RenderSandboxProvider — Render Sandboxes as a SandboxProvider.
 * All @renderinc/sdk imports are isolated here.
 */
import { Render } from "@renderinc/sdk";
import { BaseSandbox } from "./base.js";
import type {
  Sandbox,
  SandboxProvider,
  SandboxExecEvent,
  SandboxExecOptions,
  SandboxDownload,
  SandboxUploadData,
  SandboxUploadOptions,
  SandboxStatus,
  CreateSandboxOptions,
} from "./types.js";

export interface RenderSandboxProviderOptions {
  token?: string;
  ownerId?: `tea-${string}`;
  /** Max wait for sandbox readiness (ms). Default 120_000. */
  readyTimeoutMs?: number;
  /** Polling interval (ms). Default 1_500. */
  pollIntervalMs?: number;
}

const STATUS_MAP: Record<string, SandboxStatus> = {
  pending: "pending",
  running: "running",
  errored: "errored",
  terminated: "terminated",
};

type SandboxesClient = InstanceType<typeof Render>["experimental"]["sandboxes"];

export class RenderSandboxProvider implements SandboxProvider {
  readonly name = "render";
  private readonly client: SandboxesClient;
  private readonly ownerId?: `tea-${string}`;
  private readonly readyTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(opts: RenderSandboxProviderOptions = {}) {
    const ownerId =
      opts.ownerId ??
      (process.env.RENDER_WORKSPACE_ID as `tea-${string}` | undefined);

    const render = new Render({
      token: opts.token,
      ownerId,
      useLocalDev: false,
      baseUrl: "https://api.render.com",
    });

    this.client = render.experimental.sandboxes;
    this.ownerId = ownerId;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_500;
  }

  async create(opts?: CreateSandboxOptions): Promise<Sandbox> {
    const result = await this.client.create({
      ownerId: this.ownerId,
      timeoutSeconds: opts?.timeoutSeconds,
    });

    await this.waitForReady(result.id);
    return new RenderSandbox(this.client, result.id, this.ownerId);
  }

  async connect(sandboxId: string): Promise<Sandbox> {
    return new RenderSandbox(this.client, sandboxId, this.ownerId);
  }

  private async waitForReady(sandboxId: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;

    while (Date.now() < deadline) {
      const current = await this.client.get(sandboxId, this.ownerId);
      if (current?.status === "running") return;
      if (
        current?.status === "errored" ||
        current?.status === "terminated"
      ) {
        throw new Error(
          `Sandbox ${sandboxId} entered terminal state: ${current.status}`,
        );
      }
      await sleep(this.pollIntervalMs);
    }

    throw new Error(
      `Sandbox ${sandboxId} did not become ready within ${this.readyTimeoutMs}ms`,
    );
  }
}

class RenderSandbox extends BaseSandbox {
  constructor(
    private readonly client: SandboxesClient,
    readonly id: string,
    private readonly ownerId?: `tea-${string}`,
  ) {
    super();
  }

  async exec(
    command: string,
    opts?: SandboxExecOptions,
  ): Promise<AsyncGenerator<SandboxExecEvent>> {
    const generator = await this.client.exec(
      this.id,
      command,
      this.ownerId,
      opts?.signal,
    );
    return this.mapExecEvents(generator);
  }

  async upload(
    path: string,
    data: SandboxUploadData,
    opts?: SandboxUploadOptions,
  ): Promise<void> {
    await this.client.upload(this.id, path, data, this.ownerId, {
      contentType: opts?.contentType as
        | "application/octet-stream"
        | "application/x-tar"
        | "application/gzip"
        | undefined,
    });
  }

  async download(path: string): Promise<SandboxDownload> {
    const result = await this.client.download(
      this.id,
      path,
      this.ownerId,
    );
    return {
      data: Buffer.isBuffer(result.data)
        ? result.data
        : Buffer.from(result.data),
      size: result.size,
      contentType: result.contentType ?? "application/octet-stream",
    };
  }

  async status(): Promise<SandboxStatus> {
    const current = await this.client.get(this.id, this.ownerId);
    return STATUS_MAP[current?.status ?? "errored"] ?? "errored";
  }

  async terminate(): Promise<void> {
    await this.client.terminate(this.id, this.ownerId);
  }

  private async *mapExecEvents(
    source: AsyncGenerator<{
      type: string;
      stream?: string;
      data?: string;
      exit_code?: number;
    }>,
  ): AsyncGenerator<SandboxExecEvent> {
    for await (const event of source) {
      if (event.type === "output") {
        yield {
          type: "output",
          stream: (event.stream as "stdout" | "stderr") ?? "stdout",
          data: event.data ?? "",
        };
      } else if (event.type === "exit") {
        yield { type: "exit", exitCode: event.exit_code ?? 1 };
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
