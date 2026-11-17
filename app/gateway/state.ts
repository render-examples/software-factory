import type { Queryable } from "../db/index.js";
import type { ThreadKey } from "../threads/index.js";
import type { ThreadState } from "./routes.js";

/** The thread `thread` links to, and the task whose root run left it waiting for a reply. */
export async function threadState(db: Queryable, thread: ThreadKey): Promise<ThreadState> {
	const { rows } = await db.query<ThreadState>(
		`select (select linked_to from thread_links where thread = $1) as linked,
		   (select r.task from threads t join runs r on r.run_id = t.trace_id where t.thread = $1 and r.waiting = 'reply') as waiting`,
		[thread],
	);
	return rows[0] ?? { linked: null, waiting: null };
}
