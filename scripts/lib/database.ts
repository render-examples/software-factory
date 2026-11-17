import { createDb, type Db, pendingMigrations } from "../../app/db/index.js";
import { errorMessage, type Reporter } from "./output.js";

export interface DatabaseDeps {
	/** Test seam: opens DATABASE_URL. */
	openDb?: (url: string) => Db;
}

/** Read-only: DATABASE_URL connects, and the database has applied every migration in this checkout. */
export async function checkDatabase(url: string, deps: DatabaseDeps, out: Reporter): Promise<void> {
	out.addSecrets(url, passwordOf(url));
	const db = (deps.openDb ?? ((value) => createDb(value, 1)))(url);
	try {
		await db.query("select 1");
		out.pass("DATABASE_URL connects");
		const pending = await pendingMigrations(db);
		if (pending.length)
			out.warn(`migrations not applied yet: ${pending.join(", ")}`, "Both services apply them when they start: deploy or start one");
		else out.pass("migrations are current");
	} catch (error) {
		out.fail(
			`database check failed: ${errorMessage(error)}`,
			"On Render the Blueprint links factory-db's internal URL; locally, use its external URL with ?sslmode=require",
		);
	} finally {
		await db.end().catch(() => {});
	}
}

function passwordOf(url: string): string | undefined {
	try {
		return decodeURIComponent(new URL(url).password);
	} catch {
		return undefined;
	}
}
