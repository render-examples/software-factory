import type { Pool } from "pg";
import type { CancelStore } from "../cancel-store.js";

/**
 * Postgres-backed cancel store. Uses the `runs.status` column as the
 * cancel-request signal — setting it to 'cancelled' is the request;
 * the loop checks this once per iteration and exits cleanly.
 *
 * This is the one sanctioned control-signal exception to D10's
 * "everything is a projection" rule: the directly-written status is a
 * *request*, not authoritative state. The appended `run.cancelled` event
 * (emitted by the loop on exit) is the canonical terminal transition.
 */
export class PgCancelStore implements CancelStore {
  constructor(private readonly pool: Pool) {}

  async requestCancel(runId: string): Promise<void> {
    await this.pool.query(
      `UPDATE runs SET status = 'cancelled' WHERE id = $1 AND status IN ('pending', 'running', 'paused')`,
      [runId],
    );
  }

  async isCancelled(runId: string): Promise<boolean> {
    const res = await this.pool.query<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`,
      [runId],
    );
    return res.rows[0]?.status === "cancelled";
  }

  async clearCancel(_runId: string): Promise<void> {
    // No-op for Postgres: the event-driven fold handles final state.
    // This exists for KV-backed implementations that need key cleanup.
  }
}

/**
 * In-memory cancel store for testing and local dev without Postgres.
 */
export class MemoryCancelStore implements CancelStore {
  private cancelled = new Set<string>();

  async requestCancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }

  async isCancelled(runId: string): Promise<boolean> {
    return this.cancelled.has(runId);
  }

  async clearCancel(runId: string): Promise<void> {
    this.cancelled.delete(runId);
  }
}
