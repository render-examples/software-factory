import pg from "pg";

const { Pool } = pg;

export type { Pool, PoolClient } from "pg";

export interface PoolConfig {
  connectionString?: string;
  max?: number;
  applicationName?: string;
}

let sharedPool: pg.Pool | null = null;

/**
 * Process-shared Postgres pool. Safe to call multiple times — returns the
 * same pool instance for the process lifetime. Use `createPool` when you
 * need an isolated connection (e.g. a dedicated LISTEN client).
 */
export function getPool(config?: PoolConfig): pg.Pool {
  if (sharedPool) return sharedPool;
  const connectionString = config?.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("getPool: DATABASE_URL is not set and no connectionString was provided");
  }
  sharedPool = createPool({ connectionString, ...config });
  return sharedPool;
}

export function createPool(config: PoolConfig): pg.Pool {
  const connectionString = config.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("createPool: connectionString is required (or set DATABASE_URL)");
  }
  return new Pool({
    connectionString,
    max: config.max ?? 10,
    application_name: config.applicationName ?? "render-factory",
    keepAlive: true,
  });
}

export async function closeSharedPool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
}
