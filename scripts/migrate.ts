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
