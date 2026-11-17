import pg from "pg";
import { requireEnv } from "../config/index.js";

/** A connection or an open transaction. */
export interface Queryable {
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/** The caller's transaction: appends and projections run in it and commit or roll back with it. */
export type Tx = Queryable;

export interface Db extends Queryable {
	/** Commits when fn resolves and rolls back when it throws. */
	withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
	end(): Promise<void>;
}

/** A pool of at most `max` connections: 10 for the gateway, 3 for each Workflows process. */
export function createDb(connectionString: string, max: number): Db {
	const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 10_000 });
	// An idle connection that fails emits here; without a listener the error would crash the process.
	pool.on("error", (error) => console.error(JSON.stringify({ level: "warn", msg: "idle database connection failed", error: error.message })));
	return {
		query: (text, values) => pool.query(text, values),
		async withTx(fn) {
			const client = await pool.connect();
			let broken: Error | undefined;
			try {
				await client.query("begin");
				const result = await fn(client);
				await client.query("commit");
				return result;
			} catch (error) {
				await client.query("rollback").catch((rollbackError: Error) => {
					broken = rollbackError;
				});
				throw error;
			} finally {
				client.release(broken);
			}
		},
		end: () => pool.end(),
	};
}

let workflows: Db | undefined;

/** The Workflows process's pool, configured from DATABASE_URL on first use. Tasks take it as an injectable default. */
export function workflowsDb(): Db {
	workflows ??= createDb(requireEnv("DATABASE_URL"), 3);
	return workflows;
}
