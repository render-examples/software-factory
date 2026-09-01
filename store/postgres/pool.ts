import pg from "pg";

const { Pool } = pg;

export type { Pool, PoolClient } from "pg";

export interface PostgresPoolOptions {
	connectionString?: string;
	max?: number;
	applicationName?: string;
}

export function createPostgresPool(
	options: PostgresPoolOptions = {},
): pg.Pool {
	const connectionString =
		options.connectionString ?? process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error("DATABASE_URL is not set");
	}
	const configuredMax =
		options.max ??
		(process.env.FACTORY_DB_POOL_MAX
			? Number(process.env.FACTORY_DB_POOL_MAX)
			: 2);
	if (
		!Number.isSafeInteger(configuredMax) ||
		configuredMax < 1 ||
		configuredMax > 20
	) {
		throw new Error("FACTORY_DB_POOL_MAX must be an integer from 1 to 20");
	}
	return new Pool({
		connectionString,
		max: configuredMax,
		application_name:
			options.applicationName ?? "render-factory",
		connectionTimeoutMillis: 5_000,
		idleTimeoutMillis: 10_000,
		allowExitOnIdle: true,
		options:
			"-c statement_timeout=15000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000",
	});
}
