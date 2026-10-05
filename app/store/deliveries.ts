import { db } from "./pool.js";
import type { DeliveryOutcome, DeliveryRecord } from "./types.js";

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

export async function getDelivery(deliveryId: string): Promise<DeliveryRecord | null> {
	const { rows } = await db().query(
		"SELECT delivery_id, event, action, outcome, detail, received_at FROM deliveries WHERE delivery_id = $1",
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
