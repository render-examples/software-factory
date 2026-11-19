import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { append, createDb, type Db, migrate, pendingMigrations, readStream, readThread, type Tx, VersionConflict } from "../app/db/index.js";
import { defineEvent } from "../app/events/index.js";
import type { ThreadKey } from "../app/threads/index.js";
import { postgresDatabase, TEST_DATABASE_URL } from "./helpers/db.js";

const noted = defineEvent("test.noted", 1, z.strictObject({ text: z.string().max(100) }));
const note = (stream: string, text: string, thread?: ThreadKey) => ({ type: noted, stream, thread, source: "gateway", payload: { text } });
const newStream = () => `run:${randomUUID()}`;

describe.skipIf(!TEST_DATABASE_URL)("event log on Postgres", () => {
	let database: Awaited<ReturnType<typeof postgresDatabase>>;
	let db: Db;
	beforeAll(async () => {
		database = await postgresDatabase();
		db = createDb(database.url, 5);
		await migrate(db);
	});
	afterAll(async () => {
		await db.end();
		await database.drop();
	});

	async function hold(work: (tx: Tx) => Promise<unknown>): Promise<{ commit(): Promise<void> }> {
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let ready = () => {};
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const done = db.withTx(async (tx) => {
			await work(tx);
			ready();
			await released;
		});
		await Promise.race([started, done]);
		return {
			async commit() {
				release();
				await done;
			},
		};
	}

	async function untilATransactionWaitsOnALock(): Promise<void> {
		for (let attempt = 0; attempt < 250; attempt++) {
			const { rows } = await db.query<{ waiting: number }>(
				"select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
			);
			if (rows[0]?.waiting) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("no transaction is waiting on a lock");
	}

	it("delivers a thread's event whose transaction commits after a later one with a higher seq", async () => {
		const thread: ThreadKey = `github:acme/web#issue-${randomUUID()}`;
		const start = { tx: "0", seq: 0 };
		const late = await hold((tx) => append(tx, note("run:late", "late", thread)));
		await db.withTx((tx) => append(tx, note("run:early", "early", thread)));

		expect(await readThread(db, thread, start)).toEqual([]);
		await late.commit();
		const events = await readThread(db, thread, start);
		expect(events.map((event) => event.stream)).toEqual(["run:late", "run:early"]);
		expect(events[0]?.seq).toBeLessThan(events[1]?.seq ?? 0);
	});

	it.each([
		["the next version", undefined],
		["an expected version", 0],
	])("lets one of two appends racing for %s win, without a gap in the stream", async (_, expectedVersion) => {
		const stream = newStream();
		const first = await hold((tx) => append(tx, note(stream, "first"), { expectedVersion }));
		const second = db.withTx((tx) => append(tx, note(stream, "second"), { expectedVersion }));
		await untilATransactionWaitsOnALock();
		expect(await readStream(db, stream, 0)).toEqual([]);

		await first.commit();
		await expect(second).rejects.toBeInstanceOf(VersionConflict);
		await db.withTx((tx) => append(tx, note(stream, "retried")));
		expect((await readStream(db, stream, 0)).map((event) => [event.streamVersion, event.payload])).toEqual([
			[1, { text: "first" }],
			[2, { text: "retried" }],
		]);
	});

	it("applies each migration once when two processes start at once", async () => {
		const fresh = await postgresDatabase();
		const [gateway, workflows] = [createDb(fresh.url, 1), createDb(fresh.url, 1)];
		try {
			const applied = await Promise.all([migrate(gateway), migrate(workflows)]);
			const { rows } = await gateway.query<{ name: string }>("select name from schema_migrations order by name");
			expect(rows.length).toBeGreaterThan(0);
			expect(applied.map((names) => names.length).sort()).toEqual([0, rows.length]);
			expect(applied.flat()).toEqual(rows.map((row) => row.name));
			expect(await pendingMigrations(workflows)).toEqual([]);
		} finally {
			await Promise.all([gateway.end(), workflows.end()]);
			await fresh.drop();
		}
	});
});
