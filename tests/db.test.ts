import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	append,
	appendMany,
	type Db,
	type LogEvent,
	migrate,
	type Projection,
	pendingMigrations,
	readStream,
	readThread,
	rebuild,
	type Tx,
	VersionConflict,
} from "../app/db/index.js";
import { defineEvent } from "../app/events/index.js";
import type { ThreadKey } from "../app/threads/index.js";
import { pgliteDb } from "./helpers/db.js";

const noted = defineEvent("test.noted", 1, z.strictObject({ text: z.string().max(300_000) }));
const START = { tx: "0", seq: 0 };

let db: Db;
let pglite: PGlite;
beforeAll(async () => {
	({ db, pglite } = await pgliteDb());
});
afterAll(() => db.end());

const newStream = () => `run:${randomUUID()}`;
const body = (text: string, extra: { thread?: ThreadKey; idempotencyKey?: string } = {}) => ({
	type: noted,
	source: "gateway",
	payload: { text },
	...extra,
});
const note = (stream: string, text: string, extra: { thread?: ThreadKey; idempotencyKey?: string } = {}) => ({ stream, ...body(text, extra) });

describe("append", () => {
	it("records the type, version, source, thread, and validated payload, numbering each stream from 1 for paged reads", async () => {
		const [stream, other] = [newStream(), newStream()];
		const logged = await db.withTx(async (tx) => [
			await append(tx, note(stream, "hello", { thread: "github:acme/web#issue-12" })),
			await append(tx, note(other, "1")),
			await append(tx, note(stream, "2")),
			await append(tx, note(stream, "3")),
		]);
		expect(logged[0]).toMatchObject({
			stream,
			type: "test.noted",
			version: 1,
			source: "gateway",
			thread: "github:acme/web#issue-12",
			payload: { text: "hello" },
		});
		expect(logged.map((event) => [event?.stream, event?.streamVersion])).toEqual([
			[stream, 1],
			[other, 1],
			[stream, 2],
			[stream, 3],
		]);
		expect(await readStream(db, stream, 0, 2)).toEqual([logged[0], logged[2]]);
		expect(await readStream(db, stream, 2, 2)).toEqual([logged[3]]);
	});

	it("appends at the expected version and fails with VersionConflict at any other", async () => {
		const stream = newStream();
		await db.withTx((tx) => append(tx, note(stream, "first"), { expectedVersion: 0 }));
		await expect(db.withTx((tx) => append(tx, note(stream, "stale"), { expectedVersion: 0 }))).rejects.toBeInstanceOf(VersionConflict);
		await expect(db.withTx((tx) => append(tx, note(stream, "ahead"), { expectedVersion: 2 }))).rejects.toBeInstanceOf(VersionConflict);
		await db.withTx((tx) => append(tx, note(stream, "second"), { expectedVersion: 1 }));
		expect((await readStream(db, stream, 0)).map((event) => event.payload)).toEqual([{ text: "first" }, { text: "second" }]);
	});

	it("returns null for a repeated idempotency key and changes nothing, even when the stream has moved on", async () => {
		const stream = newStream();
		const key = randomUUID();
		await db.withTx((tx) => append(tx, note(stream, "once", { idempotencyKey: key }), { expectedVersion: 0 }));
		expect(await db.withTx((tx) => append(tx, note(stream, "again", { idempotencyKey: key }), { expectedVersion: 0 }))).toBeNull();
		expect(await db.withTx((tx) => append(tx, note(newStream(), "elsewhere", { idempotencyKey: key })))).toBeNull();
		expect((await readStream(db, stream, 0)).map((event) => event.payload)).toEqual([{ text: "once" }]);
	});

	it("rejects a payload that doesn't parse or is larger than 256 KB, writing nothing", async () => {
		const stream = newStream();
		await expect(db.withTx((tx) => append(tx, { ...note(stream, ""), payload: { text: 1 } as never }))).rejects.toThrow();
		await expect(db.withTx((tx) => append(tx, { ...note(stream, ""), payload: { text: "x", token: "secret" } as never }))).rejects.toThrow();
		await expect(db.withTx((tx) => append(tx, note(stream, "x".repeat(256 * 1024))))).rejects.toThrow("larger than 256 KB");
		expect(await readStream(db, stream, 0)).toEqual([]);
	});

	it("rejects a thread that isn't namespaced as <channel>:<id>, writing nothing", async () => {
		const stream = newStream();
		for (const thread of ["acme/web#issue-12", "GitHub:acme/web#issue-12", "github:", "github:acme web"]) {
			await expect(db.withTx((tx) => append(tx, note(stream, "x", { thread: thread as ThreadKey })))).rejects.toThrow("invalid thread key");
		}
		expect(await readStream(db, stream, 0)).toEqual([]);
	});

	it("notifies listeners only when the transaction commits", async () => {
		const heard: string[] = [];
		const unlisten = await pglite.listen("events", (payload) => heard.push(payload));
		const [committed, rolledBack] = [newStream(), newStream()];
		await db.withTx(async (tx) => {
			await append(tx, note(committed, "kept"));
			await tx.query("select 1");
			expect(heard).toEqual([]);
		});
		await expect(
			db.withTx(async (tx) => {
				await append(tx, note(rolledBack, "dropped"));
				throw new Error("abort");
			}),
		).rejects.toThrow("abort");
		await unlisten();
		expect(heard).toEqual([`${committed} 1`]);
		expect(await readStream(db, rolledBack, 0)).toEqual([]);
	});

	it("appendMany appends to one stream in order, fenced by the expected version, and skips repeats", async () => {
		const stream = newStream();
		const key = randomUUID();
		await db.withTx((tx) => append(tx, note(stream, "first", { idempotencyKey: key })));
		const logged = await db.withTx((tx) =>
			appendMany(tx, stream, [body("first", { idempotencyKey: key }), body("a"), body("b")], { expectedVersion: 1 }),
		);
		expect(logged.map((event) => [event.streamVersion, event.payload])).toEqual([
			[2, { text: "a" }],
			[3, { text: "b" }],
		]);
		await expect(db.withTx((tx) => appendMany(tx, stream, [body("c")], { expectedVersion: 1 }))).rejects.toBeInstanceOf(VersionConflict);
	});
});

describe("ordered reads", () => {
	it("pages a thread across streams by (tx, seq)", async () => {
		const thread: ThreadKey = `github:acme/web#issue-${randomUUID()}`;
		const [threadStream, run] = [`thread:${thread}`, newStream()];
		await db.withTx((tx) => append(tx, note(threadStream, "opened", { thread })));
		await db.withTx(async (tx) => {
			await append(tx, note(run, "started", { thread }));
			await append(tx, note(newStream(), "unrelated"));
			await append(tx, note(run, "finished", { thread }));
		});
		const first = await readThread(db, thread, START, 2);
		const last = first.at(-1) as LogEvent;
		const rest = await readThread(db, thread, { tx: last.tx, seq: last.seq }, 2);
		expect([...first, ...rest].map((event) => event.payload)).toEqual([{ text: "opened" }, { text: "started" }, { text: "finished" }]);
	});
});

describe("rebuild", () => {
	const counts: Projection = {
		table: "test_counts",
		key: ["stream"],
		operational: ["comment_id"],
		async apply(tx: Tx, event: LogEvent) {
			if (event.type !== noted.type) return;
			await tx.query(
				`insert into test_counts (stream, notes, updated_seq) values ($1, 1, $2)
				 on conflict (stream) do update set notes = test_counts.notes + 1, updated_seq = excluded.updated_seq`,
				[event.stream, event.seq],
			);
		},
	};

	it("replays the log into empty projections and keeps operational columns", async () => {
		const { db: fresh } = await pgliteDb();
		await fresh.query("create table test_counts (stream text primary key, notes int not null, comment_id bigint, updated_seq bigint not null)");
		const [a, b] = [newStream(), newStream()];
		await fresh.withTx((tx) =>
			appendMany(
				tx,
				a,
				["1", "2"].map((text) => body(text)),
			),
		);
		await fresh.withTx((tx) => append(tx, note(b, "1")));
		await fresh.query("insert into test_counts values ($1, 99, 42, 0)", [a]);

		expect(await rebuild(fresh, [counts])).toBe(3);
		expect((await fresh.query("select stream, notes, comment_id from test_counts order by notes desc")).rows).toEqual([
			{ stream: a, notes: 2, comment_id: 42 },
			{ stream: b, notes: 1, comment_id: null },
		]);
		await fresh.end();
	});
});

describe("migrate", () => {
	it("is idempotent", async () => {
		expect(await pendingMigrations(db)).toEqual([]);
		expect(await migrate(db)).toEqual([]);
	});
});
