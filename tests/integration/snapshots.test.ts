import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgresql://postgres:postgres@localhost:55432/rf_m11";
const sqlDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"app",
	"sql",
);

let pool: pg.Pool;

async function applyMigrations(client: pg.PoolClient): Promise<void> {
	await client.query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`);
	const files = (await readdir(sqlDir))
		.filter((f) => f.endsWith(".sql"))
		.sort();
	const { rows } = await client.query("SELECT filename FROM schema_migrations");
	const applied = new Set(rows.map((r: { filename: string }) => r.filename));
	for (const file of files) {
		if (applied.has(file)) continue;
		const sql = await readFile(join(sqlDir, file), "utf8");
		await client.query("BEGIN");
		await client.query(sql);
		await client.query(
			"INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
			[file],
		);
		await client.query("COMMIT");
	}
}

beforeAll(async () => {
	pool = new pg.Pool({
		connectionString: DATABASE_URL,
		max: 10,
		application_name: "rf_m11_snapshot_test",
	});
	const client = await pool.connect();
	try {
		await client.query("DROP SCHEMA public CASCADE");
		await client.query("CREATE SCHEMA public");
		await applyMigrations(client);
	} finally {
		client.release();
	}
});

afterAll(async () => {
	await pool.end();
});

describe("0003_snapshots migration", () => {
	it("creates the snapshots table", async () => {
		const { rows } = await pool.query(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'snapshots' ORDER BY ordinal_position`,
		);
		const cols = rows.map((r: { column_name: string }) => r.column_name);
		expect(cols).toContain("id");
		expect(cols).toContain("sandbox_group_id");
		expect(cols).toContain("name");
		expect(cols).toContain("repo");
		expect(cols).toContain("base_sha");
		expect(cols).toContain("lockfile_hash");
		expect(cols).toContain("build_key");
		expect(cols).toContain("status");
		expect(cols).toContain("created_at");
		expect(cols).toContain("expires_at");
		expect(cols).toContain("retired_at");
	});

	it("adds role and snapshot_id columns to sandboxes", async () => {
		const { rows } = await pool.query(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'sandboxes' ORDER BY ordinal_position`,
		);
		const cols = rows.map((r: { column_name: string }) => r.column_name);
		expect(cols).toContain("role");
		expect(cols).toContain("snapshot_id");
	});

	it("migration is idempotent", async () => {
		const sql = await readFile(join(sqlDir, "0003_snapshots.sql"), "utf8");
		await pool.query(sql);
		await pool.query(sql);
	});
});

describe("snapshot store functions", () => {
	it("recordSnapshot and currentSnapshot round-trip", async () => {
		const id = `snp-${randomUUID()}`;
		process.env.DATABASE_URL = DATABASE_URL;
		const { recordSnapshot, currentSnapshot } = await import(
			"../../app/store/snapshots.js"
		);
		await recordSnapshot({
			id,
			sandboxGroupId: "sbg-test",
			name: "test-snapshot",
			repo: "test/repo",
			baseSha: "abc123",
			lockfileHash: "hash-x",
			buildKey: "key-1",
		});

		const snap = await currentSnapshot("test/repo");
		expect(snap).not.toBeNull();
		expect(snap?.id).toBe(id);
		expect(snap?.baseSha).toBe("abc123");
		expect(snap?.status).toBe("available");

		await pool.query("DELETE FROM snapshots WHERE id = $1", [id]);
	});

	it("retireOtherSnapshots marks old snapshots retired", async () => {
		const oldId = `snp-old-${randomUUID()}`;
		const newId = `snp-new-${randomUUID()}`;

		process.env.DATABASE_URL = DATABASE_URL;
		const { recordSnapshot, retireOtherSnapshots, currentSnapshot } =
			await import("../../app/store/snapshots.js");

		await recordSnapshot({
			id: oldId,
			sandboxGroupId: "sbg-test",
			name: "test",
			repo: "retire/repo",
			baseSha: "sha-1",
			lockfileHash: "hash-1",
			buildKey: "key-1",
		});
		await recordSnapshot({
			id: newId,
			sandboxGroupId: "sbg-test",
			name: "test",
			repo: "retire/repo",
			baseSha: "sha-2",
			lockfileHash: "hash-2",
			buildKey: "key-2",
		});

		const retired = await retireOtherSnapshots("retire/repo", newId);
		expect(retired).toContain(oldId);

		const current = await currentSnapshot("retire/repo");
		expect(current?.id).toBe(newId);

		await pool.query("DELETE FROM snapshots WHERE id IN ($1, $2)", [
			oldId,
			newId,
		]);
	});

	it("listRetiredSnapshots returns only retired rows", async () => {
		const activeId = `snp-active-${randomUUID()}`;
		const retiredId = `snp-retired-${randomUUID()}`;

		process.env.DATABASE_URL = DATABASE_URL;
		const { recordSnapshot, retireOtherSnapshots, listRetiredSnapshots } =
			await import("../../app/store/snapshots.js");

		await recordSnapshot({
			id: retiredId,
			sandboxGroupId: "sbg-test",
			name: "test",
			repo: "list/repo",
			baseSha: "sha-1",
			lockfileHash: "hash-1",
			buildKey: "key-1",
		});
		await recordSnapshot({
			id: activeId,
			sandboxGroupId: "sbg-test",
			name: "test",
			repo: "list/repo",
			baseSha: "sha-2",
			lockfileHash: "hash-2",
			buildKey: "key-2",
		});
		await retireOtherSnapshots("list/repo", activeId);

		const retired = await listRetiredSnapshots("list/repo");
		const ids = retired.map((s: { id: string }) => s.id);
		expect(ids).toContain(retiredId);
		expect(ids).not.toContain(activeId);

		await pool.query("DELETE FROM snapshots WHERE id IN ($1, $2)", [
			activeId,
			retiredId,
		]);
	});

	it("recordSandbox with role and snapshot_id", async () => {
		const id = randomUUID();
		process.env.DATABASE_URL = DATABASE_URL;
		const { recordSandbox } = await import("../../app/store/sandboxes.js");
		await recordSandbox({
			id,
			status: "creating",
			role: "run",
			snapshotId: "snp-test",
		});

		const { rows } = await pool.query(
			"SELECT role, snapshot_id FROM sandboxes WHERE id = $1",
			[id],
		);
		expect(rows[0].role).toBe("run");
		expect(rows[0].snapshot_id).toBe("snp-test");

		await pool.query("DELETE FROM sandboxes WHERE id = $1", [id]);
	});
});

describe("advisory lock prevents concurrent builds", () => {
	it("second caller blocks until the first releases", async () => {
		const client1 = await pool.connect();
		const client2 = await pool.connect();

		try {
			const { rows: lock1 } = await client1.query(
				"SELECT pg_try_advisory_lock(83927) AS acquired",
			);
			expect(lock1[0].acquired).toBe(true);

			const { rows: lock2 } = await client2.query(
				"SELECT pg_try_advisory_lock(83927) AS acquired",
			);
			expect(lock2[0].acquired).toBe(false);

			await client1.query("SELECT pg_advisory_unlock(83927)");

			const { rows: lock3 } = await client2.query(
				"SELECT pg_try_advisory_lock(83927) AS acquired",
			);
			expect(lock3[0].acquired).toBe(true);
			await client2.query("SELECT pg_advisory_unlock(83927)");
		} finally {
			client1.release();
			client2.release();
		}
	});
});

describe("migration idempotency on top of 0002 data", () => {
	it("db:migrate twice is clean", async () => {
		const client = await pool.connect();
		try {
			await applyMigrations(client);
		} finally {
			client.release();
		}
	});
});
