/**
 * Apply the SQL in app/sql, in filename order.
 *
 * Run by the gateway's preDeployCommand in render.yaml, so the schema exists
 * before any new instance serves traffic. Each file is written to be
 * idempotent (`create ... if not exists`), which is why there is no applied-
 * migrations ledger — re-running is always safe.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../app/store/index.js";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "sql");
const files = (await readdir(sqlDir)).filter((name) => name.endsWith(".sql")).sort();

for (const file of files) {
	console.log(`applying ${file}`);
	await db().query(await readFile(join(sqlDir, file), "utf8"));
}

await db().end();
console.log(`applied ${files.length} migration(s)`);
