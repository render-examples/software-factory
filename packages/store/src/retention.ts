import type { RunStore, RetentionOptions, RetentionResult } from "./run-store.js";

const DEFAULT_EVENT_RETENTION_DAYS = 30;
const DEFAULT_RUN_RETENTION_DAYS = 90;

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

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
