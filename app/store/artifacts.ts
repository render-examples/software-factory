import { createHash, randomUUID } from "node:crypto";
import { factoryConfig } from "../../factory.config.js";
import { db } from "./pool.js";
import type { ArtifactRecord } from "./types.js";

export type ArtifactKind =
	| "screenshot"
	| "trace"
	| "transcript"
	| "log"
	| "report";

export async function putArtifact(input: {
	runId: string;
	kind: ArtifactKind;
	contentType: string;
	bytes: Buffer;
	linkToken?: string;
	expiresInDays?: number;
}): Promise<ArtifactRecord> {
	const maxPerArtifact = factoryConfig.limits.artifactBytes;
	const maxPerRun = factoryConfig.limits.runArtifactBytes;

	if (input.bytes.length > maxPerArtifact) {
		throw new Error(
			`Artifact size ${input.bytes.length} exceeds per-artifact cap of ${maxPerArtifact}`,
		);
	}

	const { rows: usageRows } = await db().query(
		"SELECT COALESCE(SUM(size), 0)::bigint AS total FROM artifacts WHERE run_id = $1",
		[input.runId],
	);
	const currentTotal = Number(usageRows[0].total);
	if (currentTotal + input.bytes.length > maxPerRun) {
		throw new Error(
			`Adding ${input.bytes.length} bytes would exceed per-run artifact cap of ${maxPerRun} (current: ${currentTotal})`,
		);
	}

	const id = randomUUID();
	const sha256 = createHash("sha256").update(input.bytes).digest("hex");
	const linkTokenHash = input.linkToken
		? createHash("sha256").update(input.linkToken).digest("hex")
		: null;
	const expiresAt = new Date(
		Date.now() + (input.expiresInDays ?? 30) * 24 * 60 * 60 * 1000,
	);

	await db().query(
		`INSERT INTO artifacts (id, run_id, kind, content_type, bytes, size, sha256, link_token_hash, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		[
			id,
			input.runId,
			input.kind,
			input.contentType,
			input.bytes,
			input.bytes.length,
			sha256,
			linkTokenHash,
			expiresAt,
		],
	);

	return {
		id,
		runId: input.runId,
		kind: input.kind,
		contentType: input.contentType,
		size: input.bytes.length,
		sha256,
		linkTokenHash,
		createdAt: new Date().toISOString(),
		expiresAt: expiresAt.toISOString(),
	};
}

export async function getArtifact(
	id: string,
): Promise<{ record: ArtifactRecord; bytes: Buffer } | null> {
	const { rows } = await db().query(
		`SELECT id, run_id, kind, content_type, bytes, size, sha256, link_token_hash, created_at, expires_at
		 FROM artifacts WHERE id = $1`,
		[id],
	);
	if (rows.length === 0) return null;
	const row = rows[0];
	return {
		record: {
			id: row.id,
			runId: row.run_id,
			kind: row.kind,
			contentType: row.content_type,
			size: row.size,
			sha256: row.sha256,
			linkTokenHash: row.link_token_hash,
			createdAt: (row.created_at as Date).toISOString(),
			expiresAt: (row.expires_at as Date).toISOString(),
		},
		bytes: row.bytes,
	};
}

export async function getArtifactByLinkToken(
	token: string,
): Promise<{ record: ArtifactRecord; bytes: Buffer } | null> {
	const hash = createHash("sha256").update(token).digest("hex");
	const { rows } = await db().query(
		`SELECT id, run_id, kind, content_type, bytes, size, sha256, link_token_hash, created_at, expires_at
		 FROM artifacts WHERE link_token_hash = $1 AND expires_at > now()`,
		[hash],
	);
	if (rows.length === 0) return null;
	const row = rows[0];
	return {
		record: {
			id: row.id,
			runId: row.run_id,
			kind: row.kind,
			contentType: row.content_type,
			size: row.size,
			sha256: row.sha256,
			linkTokenHash: row.link_token_hash,
			createdAt: (row.created_at as Date).toISOString(),
			expiresAt: (row.expires_at as Date).toISOString(),
		},
		bytes: row.bytes,
	};
}

export async function deleteExpiredArtifacts(): Promise<number> {
	const result = await db().query(
		"DELETE FROM artifacts WHERE expires_at <= now()",
	);
	return result.rowCount ?? 0;
}
