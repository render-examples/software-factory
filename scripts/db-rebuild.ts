/**
 * Rebuilds every projection from the event log, keeping operational columns. Appends wait until it commits.
 *
 *   npm run db:rebuild
 */
import { requireEnv } from "../app/config/index.js";
import { createDb, rebuild } from "../app/db/index.js";

const db = createDb(requireEnv("DATABASE_URL"), 1);
try {
	console.log(`replayed ${await rebuild(db)} events`);
} finally {
	await db.end();
}
