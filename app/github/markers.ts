import { createHash } from "node:crypto";
import { z } from "zod";
import type { IssueComment } from "./types.js";

/**
 * Hidden markers on factory-written comments: `<!-- software-factory:<kind> <base64url JSON> -->`. They're how a
 * run finds its own earlier writes in GitHub, so they're trusted only on comments the App's bot authored.
 */

export const RUN_STATES = ["running", "done", "failed", "cancelled", "rejected"] as const;
export type RunState = (typeof RUN_STATES)[number];

const StatusMarker = z.object({
	runId: z.string().min(1),
	phase: z.string().min(1),
	state: z.enum(RUN_STATES),
	/** ISO 8601 */
	at: z.string().optional(),
});

const SpecMarker = z.object({
	spec: z.unknown(),
	/** sha256 of the spec's canonical JSON; a marker whose spec doesn't match it is ignored. */
	hash: z.string().regex(/^[0-9a-f]{64}$/),
	version: z.number().int().positive(),
});

const OpenMarker = z.record(z.string(), z.unknown());

const SCHEMAS = { status: StatusMarker, spec: SpecMarker, questions: OpenMarker, review: OpenMarker } as const;

export type MarkerKind = keyof typeof SCHEMAS;
export type MarkerData = { [K in MarkerKind]: z.infer<(typeof SCHEMAS)[K]> };
export type StatusMarker = MarkerData["status"];
export type SpecMarker = MarkerData["spec"];

/** GitHub caps a comment at 65,536 characters; the marker leaves room for the readable part. */
export const MAX_MARKER_CHARS = 48_000;

export function renderMarker<K extends MarkerKind>(kind: K, data: MarkerData[K]): string {
	const encoded = Buffer.from(JSON.stringify(SCHEMAS[kind].parse(data)), "utf8").toString("base64url");
	const marker = `<!-- software-factory:${kind} ${encoded} -->`;
	if (marker.length > MAX_MARKER_CHARS) throw new Error(`${kind} marker is ${marker.length} characters; the limit is ${MAX_MARKER_CHARS}`);
	return marker;
}

/**
 * The marker's data, or null when the body has none or it doesn't decode and validate. Tolerates surrounding
 * edits, whitespace, and CRLF; with several markers of one kind, the last one wins.
 */
export function parseMarker<K extends MarkerKind>(body: string, kind: K): MarkerData[K] | null {
	const pattern = new RegExp(`<!--\\s*software-factory:${kind}\\s+([A-Za-z0-9_-]+)\\s*-->`, "g");
	const matches = [...body.matchAll(pattern)];
	const encoded = matches.at(-1)?.[1];
	if (!encoded) return null;
	let json: unknown;
	try {
		json = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	const parsed = SCHEMAS[kind].safeParse(json);
	if (!parsed.success) return null;
	if (kind === "spec" && (parsed.data as SpecMarker).hash !== contentHash((parsed.data as SpecMarker).spec)) return null;
	return parsed.data as MarkerData[K];
}

/** The newest comment carrying a valid `kind` marker and authored by the App's bot. Anyone can paste a marker. */
export function findMarkedComment<K extends MarkerKind>(
	comments: readonly IssueComment[],
	kind: K,
	botLogin: string,
): { comment: IssueComment; data: MarkerData[K] } | null {
	const bot = botLogin.toLowerCase();
	for (let i = comments.length - 1; i >= 0; i--) {
		const comment = comments[i];
		if (!comment || comment.author.login.toLowerCase() !== bot) continue;
		const data = parseMarker(comment.body, kind);
		if (data) return { comment, data };
	}
	return null;
}

/** sha256 of the value's canonical JSON (object keys sorted), so key order never changes the hash. */
export function contentHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
