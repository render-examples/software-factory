import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- Migration registry ---

/**
 * Stable 64-bit advisory lock ID for render-factory migrations.
 * Derived from a hash of "render-factory:migrations" — must never change.
 */
const MIGRATION_LOCK_ID = "5765329847";

const CORE_MIGRATIONS = [
  "0001_threads.sql",
  "0002_runs.sql",
  "0003_run_events.sql",
  "0004_projections.sql",
  "0005_messages_oauth.sql",
  "0006_schedules_fk.sql",
  "0007_run_jobs.sql",
  "0008_run_parent_span.sql",
  "0009_channels.sql",
  "0010_deliver_jobs.sql",
  "0011_schedule_user.sql",
  "0012_rls.sql",
  "0013_event_envelope.sql",
  "0014_lease_tokens.sql",
  "0015_commands.sql",
  "0016_inbound_queue.sql",
  "0017_thread_surfaces_items.sql",
  "0018_artifacts.sql",
];

// --- Migration runner ---

/**
 * Apply all schema migrations under a Postgres advisory lock.
 *
 * Idempotent: every migration uses `IF NOT EXISTS` / `CREATE OR REPLACE`.
 * Safe under concurrent boot — Postgres advisory lock serializes callers
 * so only one process does DDL; the rest acquire the lock after release
 * and find every `IF NOT EXISTS` a no-op.
 */
export async function applyMigrations(pool: Pool): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    try {
      // Version ledger: run each migration at most once so future non-idempotent
      // migrations are safe; backfilling it once against IF-NOT-EXISTS files is a no-op.
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           name TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );
      const doneRes = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
      const done = new Set(doneRes.rows.map((r) => r.name));

      for (const name of CORE_MIGRATIONS) {
        if (done.has(name)) continue;
        const sql = loadMigrationSql(name);
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
          [name],
        );
        applied.push(name);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
  return applied;
}

// --- SQL file loader ---

function loadMigrationSql(name: string): string {
  // Resolve from both src and dist layouts.
  const candidates = [
    join(HERE, "..", "..", "sql", name),
    join(HERE, "..", "sql", name),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error(`applyMigrations: could not locate migration file "${name}"`);
}
