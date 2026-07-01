import type { RunStore, RetentionOptions, RetentionResult, ReapResult } from "./run-store.js";

const DEFAULT_EVENT_RETENTION_DAYS = 30;
const DEFAULT_RUN_RETENTION_DAYS = 90;
/** Default stranded-run horizon: 15 minutes of silence (E6). Generous so a
 * legitimately long workflow that keeps emitting events is never reaped. */
const DEFAULT_RUN_STALE_MS = 15 * 60 * 1000;

/**
 * Run the two-domain retention cleanup, reading horizons from the environment
 * when not provided:
 *   RENDER_AGENTS_EVENT_RETENTION_DAYS (default 30)
 *   RENDER_AGENTS_RUN_RETENTION_DAYS   (default 90)
 *
 * Invoked by a daily Render Cron (via the gateway's authed `/admin/retention`)
 * or directly in a scheduled job.
 */
export async function runRetention(store: RunStore, opts?: Partial<RetentionOptions>): Promise<RetentionResult> {
  const eventRetentionDays = opts?.eventRetentionDays ?? envInt("RENDER_AGENTS_EVENT_RETENTION_DAYS", DEFAULT_EVENT_RETENTION_DAYS);
  const runRetentionDays = opts?.runRetentionDays ?? envInt("RENDER_AGENTS_RUN_RETENTION_DAYS", DEFAULT_RUN_RETENTION_DAYS);
  return store.cleanup({ eventRetentionDays, runRetentionDays, now: opts?.now });
}

/**
 * Reap Lane A roots stranded in a non-terminal state (E6) — the workflow host
 * accepted the trigger but never progressed the run (host died, task lost). The
 * staleness horizon reads from the environment when not provided:
 *   RENDER_AGENTS_RUN_STALE_MS (default 900000 = 15m)
 *
 * Invoked by a periodic Render Cron (via the gateway's authed `/admin/runs/reap`)
 * or directly in a scheduled job.
 */
export async function reapRuns(store: RunStore, opts?: { staleMs?: number; now?: Date }): Promise<ReapResult> {
  const staleMs = opts?.staleMs ?? envInt("RENDER_AGENTS_RUN_STALE_MS", DEFAULT_RUN_STALE_MS);
  return store.reapStaleRuns({ staleMs, now: opts?.now });
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
