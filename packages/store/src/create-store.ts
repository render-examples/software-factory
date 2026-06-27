import type { RunStore } from "./run-store.js";
import { createMemoryStore } from "./memory-store.js";
import { createPgStore } from "./pg/postgres-store.js";
import type { PoolConfig } from "./pg/db.js";

export interface CreateStoreOptions extends PoolConfig {
  /**
   * Force a specific store type. When omitted, auto-detects:
   * - `DATABASE_URL` present → Postgres
   * - `DATABASE_URL` absent → in-memory
   */
  type?: "memory" | "postgres";
}

/**
 * Auto-detecting store factory. The composition root calls this once at
 * boot; downstream code is store-agnostic.
 */
export function createStore(opts?: CreateStoreOptions): RunStore {
  const storeType = opts?.type ?? (process.env.DATABASE_URL ? "postgres" : "memory");

  if (storeType === "postgres") {
    return createPgStore(opts);
  }
  return createMemoryStore();
}
