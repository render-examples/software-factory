import type { Pool } from "pg";
import type { RunStore } from "./run-store.js";
import { createMemoryStore } from "./memory-store.js";
import { createPgStore, PgRunStore } from "./pg/postgres-store.js";
import { getPool, type PoolConfig } from "./pg/db.js";
import type { JobQueue } from "./job-queue.js";
import { MemoryJobQueue } from "./memory-job-queue.js";
import { PgJobQueue } from "./pg/job-queue.js";
import type { DeltaBus } from "./delta-bus.js";
import { MemoryDeltaBus } from "./delta-bus.js";
import { PgDeltaBus } from "./pg/delta-bus.js";
import type { CancelStore } from "./cancel-store.js";
import { MemoryCancelStore, PgCancelStore } from "./pg/cancel-store.js";

export interface CreateStoreOptions extends PoolConfig {
  /**
   * Force a specific store type. When omitted, auto-detects:
   * - `DATABASE_URL` present → Postgres
   * - `DATABASE_URL` absent → in-memory
   */
  type?: "memory" | "postgres";
  /** Required for Postgres stores. Scopes all reads and writes to this tenant. */
  tenantId: string;
}

/**
 * Auto-detecting store factory. The composition root calls this once at
 * boot; downstream code is store-agnostic.
 */
export function createStore(opts: CreateStoreOptions): RunStore {
  const storeType = opts.type ?? (process.env.DATABASE_URL ? "postgres" : "memory");

  if (storeType === "postgres") {
    return createPgStore(opts);
  }
  return createMemoryStore();
}

export interface CreateJobQueueOptions extends PoolConfig {
  /** Force a queue type. Defaults to postgres when a pool/`DATABASE_URL` is available, else memory. */
  type?: "memory" | "postgres";
  /** Share an existing pool (e.g. the run store's) instead of opening another. */
  pool?: Pool;
  /** Required for Postgres queues. Scopes all job operations to this tenant. */
  tenantId: string;
}

/**
 * Auto-detecting job-queue factory. Queue and run store MUST share one
 * database (jobs reference runs), so backend derives from the given store: a
 * `PgRunStore` yields a Postgres queue sharing its pool; otherwise in-memory.
 */
export function createJobQueue(opts: CreateJobQueueOptions & { store?: RunStore }): JobQueue {
  if (opts.pool) return new PgJobQueue(opts.pool, opts.tenantId);

  if (opts.type === "memory") return new MemoryJobQueue();
  if (opts.type === "postgres") {
    const pool = opts.store instanceof PgRunStore ? opts.store.pool : getPool(opts);
    return new PgJobQueue(pool, opts.tenantId);
  }

  if (opts.store) {
    return opts.store instanceof PgRunStore
      ? new PgJobQueue(opts.store.pool, opts.tenantId)
      : new MemoryJobQueue();
  }

  return process.env.DATABASE_URL ? new PgJobQueue(getPool(opts), opts.tenantId) : new MemoryJobQueue();
}

export interface CreateDeltaBusOptions extends PoolConfig {
  /** Force a bus type. Defaults to postgres when the store is Postgres-backed, else memory. */
  type?: "memory" | "postgres";
  /** Share an existing pool (e.g. the run store's) instead of opening another. */
  pool?: Pool;
}

/**
 * Auto-detecting transient delta-bus factory. Postgres bus shares the run
 * store's pool for LISTEN/NOTIFY; deltas are never persisted, so backend
 * choice only affects cross-process fan-out.
 */
export function createDeltaBus(opts?: CreateDeltaBusOptions & { store?: RunStore }): DeltaBus {
  if (opts?.pool) return new PgDeltaBus(opts.pool);

  if (opts?.type === "memory") return new MemoryDeltaBus();
  if (opts?.type === "postgres") {
    return new PgDeltaBus(opts.store instanceof PgRunStore ? opts.store.pool : getPool(opts));
  }

  if (opts?.store) {
    return opts.store instanceof PgRunStore
      ? new PgDeltaBus(opts.store.pool)
      : new MemoryDeltaBus();
  }

  return process.env.DATABASE_URL ? new PgDeltaBus(getPool(opts)) : new MemoryDeltaBus();
}

export interface CreateCancelStoreOptions extends PoolConfig {
  /** Force a cancel-store type. Defaults to postgres when the store is Postgres-backed, else memory. */
  type?: "memory" | "postgres";
  /** Share an existing pool (e.g. the run store's) instead of opening another. */
  pool?: Pool;
  /** Required for Postgres cancel stores. Scopes operations to this tenant. */
  tenantId: string;
}

/**
 * Auto-detecting cancel-store factory. Writer (cancel route) and reader
 * (agent loop's `isCancelled` poll) must share one store, so backend derives
 * from the run store: `PgRunStore` yields a `PgCancelStore` on the same pool.
 */
export function createCancelStore(opts: CreateCancelStoreOptions & { store?: RunStore }): CancelStore {
  if (opts.pool) return new PgCancelStore(opts.pool, opts.tenantId);

  if (opts.type === "memory") return new MemoryCancelStore();
  if (opts.type === "postgres") {
    const pool = opts.store instanceof PgRunStore ? opts.store.pool : getPool(opts);
    return new PgCancelStore(pool, opts.tenantId);
  }

  if (opts.store) {
    return opts.store instanceof PgRunStore
      ? new PgCancelStore(opts.store.pool, opts.tenantId)
      : new MemoryCancelStore();
  }

  return process.env.DATABASE_URL ? new PgCancelStore(getPool(opts), opts.tenantId) : new MemoryCancelStore();
}
