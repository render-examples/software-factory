import { assertMaintenanceEnv } from "../config/index.js";
import { db } from "../store/index.js";
import {
	deleteExpiredArtifacts,
	findStaleDispatched,
	requeueStaleDispatched,
	findLostExecutions,
	finishRun,
} from "../store/index.js";

assertMaintenanceEnv();

interface MaintenanceStep {
	name: string;
	run: () => Promise<void>;
}

const steps: MaintenanceStep[] = [
	{
		name: "requeue-stale-dispatched",
		async run() {
			const stale = await findStaleDispatched(5);
			for (const run of stale) {
				const requeued = await requeueStaleDispatched(run.id);
				if (requeued) {
					console.log(
						`maintenance: requeued stale dispatch ${run.id} (${run.workflow})`,
					);
				}
			}
			if (stale.length > 0) {
				console.log(
					`maintenance: requeued ${stale.length} stale dispatched run(s)`,
				);
			}
		},
	},
	{
		name: "fail-lost-executions",
		async run() {
			const lost = await findLostExecutions(10);
			for (const run of lost) {
				await finishRun(run.id, "failed", {
					outcome: "execution_lost",
					summary: "No heartbeat received within the timeout",
				});
				console.log(`maintenance: marked run ${run.id} as execution_lost`);
			}
			if (lost.length > 0) {
				console.log(`maintenance: failed ${lost.length} lost execution(s)`);
			}
		},
	},
	{
		name: "delete-expired-artifacts",
		async run() {
			const deleted = await deleteExpiredArtifacts();
			if (deleted > 0) {
				console.log(`maintenance: deleted ${deleted} expired artifact(s)`);
			}
		},
	},
];

async function runMaintenance(): Promise<void> {
	const pool = db();
	const client = await pool.connect();

	try {
		const { rows } = await client.query(
			"SELECT pg_try_advisory_lock(42) AS acquired",
		);
		if (!rows[0].acquired) {
			console.log("maintenance: another instance holds the lock, exiting");
			return;
		}

		try {
			for (const step of steps) {
				try {
					await step.run();
				} catch (err) {
					console.error(`maintenance: step "${step.name}" failed:`, err);
				}
			}
		} finally {
			await client.query("SELECT pg_advisory_unlock(42)");
		}
	} finally {
		client.release();
	}
}

try {
	await runMaintenance();
} finally {
	await db()
		.end()
		.catch(() => {});
}
