/**
 * Durable command queue. Commands represent inbound intent (e.g. a webhook
 * trigger) that must pass through policy before creating a run. They are
 * separate from `run_jobs` because they exist *before* a run does.
 *
 * Lease tokens fence stale workers: a worker must present the token issued at
 * claim time to complete/fail a command. If the token doesn't match (the reaper
 * reclaimed the command and another worker grabbed it), the operation is rejected.
 */

// --- Record & Types ---

export interface CommandRecord {
  id: string;
  kind: string;
  status: CommandStatus;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  leaseToken?: string;
  dedupeKey?: string;
  correlationId?: string;
  availableAt: string;
  lockedAt?: string;
  lockedBy?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type CommandStatus = "queued" | "running" | "done" | "failed" | "dead";

export interface EnqueueCommandOptions {
  id?: string;
  kind: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  availableAt?: string;
  dedupeKey?: string;
  correlationId?: string;
}

export interface FailCommandOptions {
  requeue?: boolean;
  backoffMs?: number;
  error?: string;
}

// --- Errors ---

export class LeaseLostError extends Error {
  constructor(commandId: string) {
    super(`Lease lost on command ${commandId}`);
    this.name = "LeaseLostError";
  }
}

// --- Store Interface ---

export interface CommandStore {
  enqueue(opts: EnqueueCommandOptions): Promise<CommandRecord>;
  claim(workerId: string): Promise<CommandRecord | undefined>;
  complete(id: string, leaseToken: string): Promise<void>;
  fail(id: string, leaseToken: string, opts?: FailCommandOptions): Promise<void>;
  heartbeat(id: string, leaseToken: string): Promise<void>;
  reap(staleMs: number): Promise<number>;
  get(id: string): Promise<CommandRecord | undefined>;
}
