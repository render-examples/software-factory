import type { CommandRecord, CommandStore } from "@render-agents/store";
import { LeaseLostError } from "@render-agents/store";

/**
 * Claim and process durable commands.
 *
 * Lease fencing prevents an old worker from settling reclaimed work. Heartbeats
 * keep live leases active. Idempotent handlers make crash retries safe.
 */

export interface CommandHandler {
  (command: CommandRecord): Promise<void>;
}

export interface WorkerOptions {
  commands: CommandStore;
  handler: CommandHandler;
  workerId: string;
  pollIntervalMs?: number;
  visibilityTimeoutMs?: number;
  reapIntervalMs?: number;
  onEvent?: (event: WorkerEvent) => void;
}

export type WorkerEvent =
  | { type: "claimed"; commandId: string; kind: string; attempts: number }
  | { type: "completed"; commandId: string }
  | { type: "failed"; commandId: string; error: string; requeued: boolean }
  | { type: "lease_lost"; commandId: string }
  | { type: "reaped"; count: number }
  | { type: "idle" };

const DEFAULTS = {
  pollIntervalMs: 200,
  visibilityTimeoutMs: 30_000,
  reapIntervalMs: 5_000,
};

function backoffMs(attempts: number): number {
  const base = Math.min(30_000, 250 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

export class ControlWorker {
  private running = false;
  private stopped: Promise<void> = Promise.resolve();
  private readonly opts: Required<Omit<WorkerOptions, "onEvent">> & Pick<WorkerOptions, "onEvent">;

  constructor(options: WorkerOptions) {
    this.opts = { ...DEFAULTS, ...options };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.stopped;
  }

  private async loop(): Promise<void> {
    let lastReap = 0;

    while (this.running) {
      if (Date.now() - lastReap > this.opts.reapIntervalMs) {
        lastReap = Date.now();
        try {
          const count = await this.opts.commands.reap(this.opts.visibilityTimeoutMs);
          if (count > 0) this.opts.onEvent?.({ type: "reaped", count });
        } catch (err) {
          console.error("[control-worker] reap failed", err);
        }
      }

      let command: CommandRecord | undefined;
      try {
        command = await this.opts.commands.claim(this.opts.workerId);
      } catch (err) {
        console.error("[control-worker] claim failed", err);
        await sleep(this.opts.pollIntervalMs);
        continue;
      }

      if (!command) {
        this.opts.onEvent?.({ type: "idle" });
        await sleep(this.opts.pollIntervalMs);
        continue;
      }

      await this.process(command);
    }
  }

  private async process(command: CommandRecord): Promise<void> {
    const lease = command.leaseToken;
    if (!lease) {
      console.error(`[control-worker] command ${command.id} has no lease; refusing to run it`);
      return;
    }

    this.opts.onEvent?.({
      type: "claimed",
      commandId: command.id,
      kind: command.kind,
      attempts: command.attempts,
    });

    const heartbeat = setInterval(() => {
      void this.opts.commands.heartbeat(command.id, lease).catch((err) => {
        if (err instanceof LeaseLostError) {
          this.opts.onEvent?.({ type: "lease_lost", commandId: command.id });
        }
      });
    }, Math.max(1_000, Math.floor(this.opts.visibilityTimeoutMs / 3)));

    try {
      await this.opts.handler(command);
      await this.opts.commands.complete(command.id, lease);
      this.opts.onEvent?.({ type: "completed", commandId: command.id });
    } catch (err) {
      if (err instanceof LeaseLostError) {
        this.opts.onEvent?.({ type: "lease_lost", commandId: command.id });
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      const requeue = command.attempts < command.maxAttempts;
      try {
        await this.opts.commands.fail(command.id, lease, {
          requeue,
          backoffMs: backoffMs(command.attempts),
          error: message,
        });
        this.opts.onEvent?.({ type: "failed", commandId: command.id, error: message, requeued: requeue });
      } catch (failErr) {
        if (failErr instanceof LeaseLostError) {
          this.opts.onEvent?.({ type: "lease_lost", commandId: command.id });
          return;
        }
        throw failErr;
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
