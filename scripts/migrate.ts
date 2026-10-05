import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../app/store/index.js";

const LOCK_ID = 0x72656e646572; // "render" as a stable advisory lock key

const sqlDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"app",
	"sql",
);
const files = (await readdir(sqlDir))
	.filter((name) => name.endsWith(".sql"))
	.sort();

const pool = db();
const client = await pool.connect();

try {
	// Serialize migrations across all processes with an advisory lock.
	await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);

	// Ensure the tracking table exists (the first migration may create it
	// too, but this bootstrap lets us track 0001 itself).
	await client.query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename    text        PRIMARY KEY,
			applied_at  timestamptz NOT NULL DEFAULT now()
		)
	`);

	const { rows } = await client.query("SELECT filename FROM schema_migrations");
	const applied = new Set(rows.map((r: { filename: string }) => r.filename));

	for (const file of files) {
		if (applied.has(file)) {
			console.log(`skipping ${file} (already applied)`);
			continue;
		}

		console.log(`applying ${file}`);
		const sql = await readFile(join(sqlDir, file), "utf8");

		await client.query("BEGIN");
		try {
			await client.query(sql);
			await client.query(
				"INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
				[file],
			);
			await client.query("COMMIT");
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		}
	}

	console.log(`${files.length} migration file(s) checked, up to date`);
} finally {
	await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
	client.release();
	await pool.end();
}
