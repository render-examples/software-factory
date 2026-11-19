import { createHash } from "node:crypto";
import { z } from "zod";
import { SHA } from "../util/index.js";
import type { IssueComment } from "./types.js";

export const RUN_STATES = ["running", "done", "failed", "cancelled", "rejected"] as const;
export type RunState = (typeof RUN_STATES)[number];

const StatusMarker = z.object({
	runId: z.string().min(1),
	traceId: z.string().min(1).optional(),
	stage: z.string().min(1),
	title: z.string().min(1).optional(),
	state: z.enum(RUN_STATES),
});

const SpecMarker = z.object({
	spec: z.unknown(),
	hash: z.string().regex(/^[0-9a-f]{64}$/),
	version: z.number().int().positive(),
	notes: z.unknown().optional(),
});

const QuestionsMarker = z.object({
	round: z.number().int().positive(),
	questions: z.array(z.string()),
});

const ReviewMarker = z.object({
	headSha: z.string().regex(SHA),
	runId: z.string().min(1),
});

const SCHEMAS = { status: StatusMarker, spec: SpecMarker, questions: QuestionsMarker, review: ReviewMarker } as const;

export type MarkerKind = keyof typeof SCHEMAS;
export type MarkerData = { [K in MarkerKind]: z.infer<(typeof SCHEMAS)[K]> };
export type SpecMarker = MarkerData["spec"];

const MAX_MARKER_CHARS = 48_000;

export function renderMarker<K extends MarkerKind>(kind: K, data: MarkerData[K]): string {
	const encoded = Buffer.from(JSON.stringify(SCHEMAS[kind].parse(data)), "utf8").toString("base64url");
	const marker = `<!-- software-factory:${kind} ${encoded} -->`;
	if (marker.length > MAX_MARKER_CHARS) throw new Error(`${kind} marker is ${marker.length} characters; the limit is ${MAX_MARKER_CHARS}`);
	return marker;
}

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
