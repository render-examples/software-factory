import { randomUUID } from "node:crypto";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { QueryResultRow } from "pg";
import { createDb, type Db, migrate } from "../../app/db/index.js";
import { PROJECTIONS } from "../../app/db/projections.js";

export async function pgliteDb(): Promise<{ db: Db; pglite: PGlite }> {
	const pglite = new PGlite();
	const db: Db = {
		query: (text, values) => run(pglite, text, values),
		withTx: (fn) => pglite.transaction((tx) => fn({ query: (text, values) => run(tx, text, values) })),
		end: () => pglite.close(),
	};
	await migrate(db);
	return { db, pglite };
}

export async function resetDb(db: Db): Promise<void> {
	await db.query(`truncate events, ${PROJECTIONS.map((projection) => projection.table).join(", ")}`);
}

async function run<R extends QueryResultRow>(target: PGlite | Transaction, text: string, values?: unknown[]): Promise<{ rows: R[] }> {
	if (values) return target.query<R>(text, values);
	const results = await target.exec(text);
	return { rows: (results.at(-1)?.rows ?? []) as R[] };
}

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export async function postgresDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
	if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
	const admin = createDb(TEST_DATABASE_URL, 1);
	const name = `sf_test_${randomUUID().replaceAll("-", "")}`;
	await admin.query(`create database ${name}`);
	const url = new URL(TEST_DATABASE_URL);
	url.pathname = `/${name}`;
	return {
		url: url.toString(),
		async drop() {
			await admin.query(`drop database ${name} with (force)`);
			await admin.end();
		},
	};
}
