import pg from "pg";

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
	if (!pool) {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error("DATABASE_URL is not set");
		pool = new pg.Pool({
			connectionString,
			max: 2,
			application_name: "render-factory",
			connectionTimeoutMillis: 5_000,
			idleTimeoutMillis: 10_000,
			allowExitOnIdle: true,
			options: "-c statement_timeout=15000 -c lock_timeout=5000",
		});
	}
	return pool;
}

export async function ping(): Promise<void> {
	await db().query("select 1");
}
