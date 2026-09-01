import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

export const REQUIRED_SCHEMA_VERSION = 5;
const MIGRATION_LOCK_KEY = 1_684_101_731;
const MIGRATIONS = [
	{ version: 1, file: "../sql/0001_initial.sql" },
	{ version: 2, file: "../sql/0002_store_hardening.sql" },
	{ version: 3, file: "../sql/0003_lease_reacquire.sql" },
	{ version: 4, file: "../sql/0004_run_hierarchy.sql" },
	{ version: 5, file: "../sql/0005_result_presence.sql" },
] as const;

export async function migratePostgres(pool: Pool): Promise<void> {
	const migrations = await Promise.all(
		MIGRATIONS.map(async (migration) => ({
			version: migration.version,
			sql: await readFile(new URL(migration.file, import.meta.url), "utf8"),
		})),
	);
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SET LOCAL statement_timeout = 0");
		await client.query("SET LOCAL lock_timeout = 0");
		await client.query("SELECT pg_advisory_xact_lock($1)", [
			MIGRATION_LOCK_KEY,
		]);
		await client.query("CREATE SCHEMA IF NOT EXISTS render_factory");
		await client.query(
			`CREATE TABLE IF NOT EXISTS render_factory.schema_migrations (
			   version INTEGER PRIMARY KEY,
			   applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
			 )`,
		);
		const applied = await client.query<{ version: number }>(
			`SELECT version FROM render_factory.schema_migrations`,
		);
		const versions = new Set(
			applied.rows.map((row) => Number(row.version)),
		);
		for (const migration of migrations) {
			if (!versions.has(migration.version)) {
				await client.query(migration.sql);
			}
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}

export async function verifyPostgresSchema(pool: Pool): Promise<void> {
	const result = await pool.query<{ version: number }>(
		`SELECT version
		 FROM render_factory.schema_migrations`,
	);
	const applied = new Set(result.rows.map((row) => Number(row.version)));
	const required = MIGRATIONS.map((m) => m.version);
	const missing = required.filter((v) => !applied.has(v));
	if (missing.length > 0) {
		throw new Error(
			`Factory store is missing schema version(s) [${missing.join(", ")}]; run npm run db:migrate`,
		);
	}
}
