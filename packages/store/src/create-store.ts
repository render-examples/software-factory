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

export interface CreateJobQueueOptions extends PoolConfig {
  /** Force a queue type. Defaults to postgres when a pool/`DATABASE_URL` is available, else memory. */
  type?: "memory" | "postgres";
  /** Share an existing pool (e.g. the run store's) instead of opening another. */
  pool?: Pool;
}

/**
 * Auto-detecting job-queue factory, mirroring `createStore`. The queue and the
 * run store MUST share one database (jobs reference runs), so the backend is
 * derived from the provided store: a `PgRunStore` yields a Postgres queue
 * sharing the store's pool; any other store yields an in-memory queue. Pass an
 * explicit `pool`/`type` to override, or omit the store to fall back to
 * `DATABASE_URL` env detection.
 */
export function createJobQueue(opts?: CreateJobQueueOptions & { store?: RunStore }): JobQueue {
  if (opts?.pool) return new PgJobQueue(opts.pool);

  if (opts?.type === "memory") return new MemoryJobQueue();
  if (opts?.type === "postgres") {
    return new PgJobQueue(opts.store instanceof PgRunStore ? opts.store.pool : getPool(opts));
  }

  // No explicit override: mirror the store's backend so both share one database.
  if (opts?.store) {
    return opts.store instanceof PgRunStore
      ? new PgJobQueue(opts.store.pool)
      : new MemoryJobQueue();
  }

  // No store given: env detection.
  return process.env.DATABASE_URL ? new PgJobQueue(getPool(opts)) : new MemoryJobQueue();
}

export interface CreateDeltaBusOptions extends PoolConfig {
  /** Force a bus type. Defaults to postgres when the store is Postgres-backed, else memory. */
  type?: "memory" | "postgres";
  /** Share an existing pool (e.g. the run store's) instead of opening another. */
  pool?: Pool;
}

/**
 * Auto-detecting transient delta-bus factory, mirroring `createJobQueue`. The
 * Postgres bus shares the run store's pool (its `LISTEN/NOTIFY` runs on the same
 * database); any non-Postgres store yields the in-memory bus. Deltas are never
 * persisted — the backend choice only affects cross-process fan-out (D12/D13).
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
}

/**
 * Auto-detecting cancel-store factory, mirroring `createJobQueue`. Cooperative
 * cancellation only works when the writer (gateway cancel route) and the reader
 * (the agent loop's per-iteration `isCancelled` poll) share one store, so the
 * backend is derived from the run store: a `PgRunStore` yields a `PgCancelStore`
 * sharing the store's pool (the request is a `runs.status = 'cancelled'` write
 * the loop reads back); any other store yields an in-memory cancel store.
 */
export function createCancelStore(opts?: CreateCancelStoreOptions & { store?: RunStore }): CancelStore {
  if (opts?.pool) return new PgCancelStore(opts.pool);

  if (opts?.type === "memory") return new MemoryCancelStore();
  if (opts?.type === "postgres") {
    return new PgCancelStore(opts.store instanceof PgRunStore ? opts.store.pool : getPool(opts));
  }

  if (opts?.store) {
    return opts.store instanceof PgRunStore
      ? new PgCancelStore(opts.store.pool)
      : new MemoryCancelStore();
  }

  return process.env.DATABASE_URL ? new PgCancelStore(getPool(opts)) : new MemoryCancelStore();
}
