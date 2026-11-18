import type { Queryable } from "../db/index.js";
import type { ThreadKey } from "../threads/index.js";
import type { ThreadState } from "./routes.js";

export async function threadState(db: Queryable, thread: ThreadKey): Promise<ThreadState> {
	const { rows } = await db.query<ThreadState>(
		"select r.task as waiting from threads t join runs r on r.run_id = t.trace_id where t.thread = $1 and r.waiting = 'reply'",
		[thread],
	);
	return rows[0] ?? { waiting: null };
}
