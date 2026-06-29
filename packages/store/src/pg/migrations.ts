import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Stable 64-bit advisory lock ID for render-agents migrations.
 * Derived from a hash of "render-agents:migrations" — must never change.
 */
const MIGRATION_LOCK_ID = "5765329847";

const CORE_MIGRATIONS = [
  "0001_threads.sql",
  "0002_runs.sql",
  "0003_run_events.sql",
  "0004_projections.sql",
  "0005_messages_oauth.sql",
  "0006_schedules_fk.sql",
];

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
      for (const name of CORE_MIGRATIONS) {
        const sql = loadMigrationSql(name);
        await client.query(sql);
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

function loadMigrationSql(name: string): string {
  // Resolve from both src and dist layouts:
  // src/pg/migrations.ts → ../../sql/<name>
  // dist/pg/migrations.js → ../../sql/<name>
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
