import type { SpanRecord } from "../api/types";

export interface SpanNode extends SpanRecord {
  children: SpanNode[];
  depth: number;
}

/** Build the span tree from a flat list via `parentId`, ordered by `seq`. */
export function buildSpanTree(spans: SpanRecord[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  for (const s of spans) byId.set(s.id, { ...s, children: [], depth: 0 });

  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const bySeq = (a: SpanNode, b: SpanNode) => a.seq - b.seq;
  const assignDepth = (node: SpanNode, depth: number) => {
    node.depth = depth;
    node.children.sort(bySeq);
    for (const c of node.children) assignDepth(c, depth + 1);
  };
  roots.sort(bySeq);
  for (const r of roots) assignDepth(r, 0);
  return roots;
}

/** Sum llm-span cost grouped by the enclosing agent span name. */
export function perAgentCost(spans: SpanRecord[]): Record<string, number> {
  const byId = new Map<string, SpanRecord>();
  for (const s of spans) byId.set(s.id, s);

  const agentNameOf = (s: SpanRecord): string => {
    let cur: SpanRecord | undefined = s;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.kind === "agent") return cur.name;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return s.kind === "agent" ? s.name : "(root)";
  };

  const totals: Record<string, number> = {};
  for (const s of spans) {
    if (s.kind !== "llm") continue;
    const cost = Number((s.attributes as { costUsd?: number } | undefined)?.costUsd ?? 0);
    if (!cost) continue;
    const agent = agentNameOf(s);
    totals[agent] = round((totals[agent] ?? 0) + cost);
  }
  return totals;
}

/** The childRunId of every subagent.spawned event, from the spans' attributes. */
export function spanCostUsd(s: SpanRecord): number {
  return Number((s.attributes as { costUsd?: number } | undefined)?.costUsd ?? 0);
}

function round(n: number): number {
  return Math.round(n * 1e12) / 1e12;
}
