import { db } from "./pool.js";
import type { DeliveryOutcome, DeliveryRecord } from "./types.js";
import type { CreateRunInput } from "./runs.js";

export type AcceptDeliveryResult =
	| { outcome: "duplicate" }
	| { outcome: "accepted"; runCreated: true }
	| { outcome: "duplicate_active_run"; runCreated: false };

/**
 * Record a delivery and optionally create a run, all in one transaction.
 * Returns "duplicate" without side effects if the delivery ID was already
 * seen (GitHub redelivery).
 */
export async function acceptDelivery(input: {
	delivery: {
		deliveryId: string;
		event: string;
		action: string;
		detail?: Record<string, unknown>;
	};
	run?: CreateRunInput;
}): Promise<AcceptDeliveryResult> {
	const client = await db().connect();
	try {
		await client.query("BEGIN");

		const ins = await client.query(
			`INSERT INTO deliveries (delivery_id, event, action, outcome, detail)
			 VALUES ($1, $2, $3, 'accepted', $4)
			 ON CONFLICT (delivery_id) DO NOTHING`,
			[
				input.delivery.deliveryId,
				input.delivery.event,
				input.delivery.action,
				input.delivery.detail ? JSON.stringify(input.delivery.detail) : null,
			],
		);

		if ((ins.rowCount ?? 0) === 0) {
			await client.query("ROLLBACK");
			return { outcome: "duplicate" };
		}

		if (!input.run) {
			await client.query("COMMIT");
			return { outcome: "accepted", runCreated: true };
		}

		const r = input.run;
		const runIns = await client.query(
			`INSERT INTO runs (
			   id, repo, subject_kind, subject_number, workflow,
			   status, trigger, input, previous_run_id
			 )
			 VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8)
			 ON CONFLICT DO NOTHING`,
			[
				r.id,
				r.repo,
				r.subjectKind,
				r.subjectNumber,
				r.workflow,
				r.trigger ? JSON.stringify(r.trigger) : null,
				r.input ? JSON.stringify(r.input) : null,
				r.previousRunId ?? null,
			],
		);

		if ((runIns.rowCount ?? 0) === 0) {
			await client.query(
				`UPDATE deliveries
				 SET outcome = 'duplicate_active_run'
				 WHERE delivery_id = $1`,
				[input.delivery.deliveryId],
			);
			await client.query("COMMIT");
			return { outcome: "duplicate_active_run", runCreated: false };
		}

		await client.query("COMMIT");
		return { outcome: "accepted", runCreated: true };
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

export async function recordDelivery(input: {
	deliveryId: string;
	event: string;
	action: string;
	outcome: DeliveryOutcome;
	detail?: Record<string, unknown>;
}): Promise<void> {
	await db().query(
		`INSERT INTO deliveries (delivery_id, event, action, outcome, detail)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (delivery_id) DO NOTHING`,
		[
			input.deliveryId,
			input.event,
			input.action,
			input.outcome,
			input.detail ? JSON.stringify(input.detail) : null,
		],
	);
}

export async function getDelivery(
	deliveryId: string,
): Promise<DeliveryRecord | null> {
	const { rows } = await db().query(
		`SELECT delivery_id, event, action, outcome, detail, received_at
		 FROM deliveries WHERE delivery_id = $1`,
		[deliveryId],
	);
	if (rows.length === 0) return null;
	const row = rows[0];
	return {
		deliveryId: row.delivery_id,
		event: row.event,
		action: row.action,
		outcome: row.outcome,
		detail: row.detail,
		receivedAt: (row.received_at as Date).toISOString(),
	};
}
