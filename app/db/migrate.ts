import { readdir, readFile } from "node:fs/promises";
import type { Db, Queryable } from "./pool.js";

const MIGRATIONS = new URL("./migrations/", import.meta.url);

/**
 * Applies pending migrations in order, in one transaction, and returns their names. Both services call it at
 * startup; the advisory lock makes the later one wait and then find nothing to apply. Keep migrations additive
 * (new tables, new nullable columns): the other service may still be running the previous code.
 */
export async function migrate(db: Db): Promise<string[]> {
	return db.withTx(async (tx) => {
		await tx.query("select pg_advisory_xact_lock(hashtext('software-factory:migrate'))");
		await tx.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
		const pending = await pendingMigrations(tx);
		for (const name of pending) {
			await tx.query(await readFile(new URL(name, MIGRATIONS), "utf8"));
			await tx.query("insert into schema_migrations (name) values ($1)", [name]);
		}
		return pending;
	});
}

/** Migration files in this checkout that the database hasn't applied, in order. */
export async function pendingMigrations(db: Queryable): Promise<string[]> {
	const files = (await readdir(MIGRATIONS)).filter((name) => /^\d{3}_\w+\.sql$/.test(name)).sort();
	const { rows } = await db.query<{ exists: boolean }>("select to_regclass('schema_migrations') is not null as exists");
	if (!rows[0]?.exists) return files;
	const applied = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((row) => row.name));
	return files.filter((name) => !applied.has(name));
}
