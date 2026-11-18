import pg from "pg";
import { requireEnv } from "../config/index.js";

export interface Queryable {
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export type Tx = Queryable;

export interface Db extends Queryable {
	withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
	end(): Promise<void>;
}

export function createDb(connectionString: string, max: number): Db {
	const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 10_000 });
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

export function workflowsDb(): Db {
	workflows ??= createDb(requireEnv("DATABASE_URL"), 3);
	return workflows;
}
