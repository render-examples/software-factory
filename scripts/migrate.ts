import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const LOCK_ID = 0x736f66747761; // "softwa": stable advisory lock key for migrations

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "sql");
const files = (await readdir(sqlDir)).filter((name) => name.endsWith(".sql")).sort();

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
	console.log("DATABASE_URL is not set: telemetry is off and there is nothing to migrate");
	process.exit(0);
}

// A dedicated client with no statement timeout: migrations may legitimately run long.
const client = new pg.Client({
	connectionString,
	application_name: "software-factory-migrate",
	connectionTimeoutMillis: 10_000,
});
await client.connect();

try {
	await client.query("select pg_advisory_lock($1)", [LOCK_ID]);
	try {
		await client.query(`
			create table if not exists schema_migrations (
				filename   text        primary key,
				applied_at timestamptz not null default now()
			)
		`);

		const { rows } = await client.query<{ filename: string }>("select filename from schema_migrations");
		const applied = new Set(rows.map((row) => row.filename));

		for (const file of files) {
			if (applied.has(file)) continue;
			console.log(`applying ${file}`);
			const sql = await readFile(join(sqlDir, file), "utf8");
			await client.query("begin");
			try {
				await client.query(sql);
				await client.query("insert into schema_migrations (filename) values ($1)", [file]);
				await client.query("commit");
			} catch (error) {
				await client.query("rollback");
				throw error;
			}
		}

		console.log(`${files.length} migration file(s) checked, up to date`);
	} finally {
		await client.query("select pg_advisory_unlock($1)", [LOCK_ID]);
	}
} finally {
	await client.end();
}
