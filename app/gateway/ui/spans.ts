import type { RunEventRecord } from "../../store/types.js";

export interface SpanNode {
	spanId: string;
	type: string;
	stage: string | null;
	phase: "span" | "point";
	startedAt: string;
	endedAt: string | null;
	durationMs: number | null;
	payload: Record<string, unknown> | null;
	endPayload: Record<string, unknown> | null;
	children: SpanNode[];
}

/**
 * Build a tree of spans from flat run_events rows.
 * - Pairs start/end events by span_id.
 * - Nests children under their parent_span_id.
 * - Shows unmatched starts (no end) with null endedAt.
 * - Points become leaf nodes with phase "point".
 */
export function buildSpanTree(events: RunEventRecord[]): SpanNode[] {
	const starts = new Map<string, RunEventRecord>();
	const ends = new Map<string, RunEventRecord>();
	const points: RunEventRecord[] = [];
	const parentMap = new Map<string, string>();

	for (const ev of events) {
		if (!ev.spanId) continue;
		if (ev.phase === "start") {
			starts.set(ev.spanId, ev);
			if (ev.parentSpanId) {
				parentMap.set(ev.spanId, ev.parentSpanId);
			}
		} else if (ev.phase === "end") {
			ends.set(ev.spanId, ev);
		} else if (ev.phase === "point") {
			points.push(ev);
			if (ev.parentSpanId) {
				parentMap.set(ev.spanId, ev.parentSpanId);
			}
		}
	}

	const nodes = new Map<string, SpanNode>();

	for (const [spanId, start] of starts) {
		const end = ends.get(spanId);
		const startMs = new Date(start.createdAt).getTime();
		const endMs = end ? new Date(end.createdAt).getTime() : null;
		nodes.set(spanId, {
			spanId,
			type: start.type,
			stage: start.stage,
			phase: "span",
			startedAt: start.createdAt,
			endedAt: end?.createdAt ?? null,
			durationMs: endMs !== null ? endMs - startMs : null,
			payload: start.payload,
			endPayload: end?.payload ?? null,
			children: [],
		});
	}

	for (const pt of points) {
		if (!pt.spanId) continue;
		nodes.set(pt.spanId, {
			spanId: pt.spanId,
			type: pt.type,
			stage: pt.stage,
			phase: "point",
			startedAt: pt.createdAt,
			endedAt: null,
			durationMs: null,
			payload: pt.payload,
			endPayload: null,
			children: [],
		});
	}

	const roots: SpanNode[] = [];

	for (const [spanId, node] of nodes) {
		const parentId = parentMap.get(spanId);
		const parent = parentId ? nodes.get(parentId) : undefined;
		if (parent) {
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}

	const sortByTime = (a: SpanNode, b: SpanNode) =>
		new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();

	function sortChildren(node: SpanNode): void {
		node.children.sort(sortByTime);
		for (const child of node.children) {
			sortChildren(child);
		}
	}

	roots.sort(sortByTime);
	for (const root of roots) {
		sortChildren(root);
	}

	return roots;
}
