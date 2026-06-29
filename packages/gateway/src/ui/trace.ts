/**
 * Pure, browser-safe trace helpers for the dev-mode viewer. No Node imports, so
 * this compiles to a plain ESM module the SPA shell loads directly, and is unit
 * testable under vitest. The viewer is a read layer over the gateway's existing
 * `/runs`, `/runs/:id/spans`, `/tool-calls`, and `/runs/:id/stream` routes.
 */

export interface SpanLike {
  id: string;
  parentId?: string;
  seq: number;
  name: string;
  kind: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  attributes?: Record<string, unknown>;
}

export interface SpanNode extends SpanLike {
  children: SpanNode[];
  depth: number;
}

/**
 * Build the collapsible span tree from a flat span list using `parentId`.
 * Roots (no/!known parent) come first; children are ordered by `seq`. Returns a
 * pre-order-friendly forest with computed `depth`.
 */
export function buildSpanTree(spans: SpanLike[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  for (const s of spans) byId.set(s.id, { ...s, children: [], depth: 0 });

  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortBySeq = (a: SpanNode, b: SpanNode) => a.seq - b.seq;
  const assignDepth = (node: SpanNode, depth: number) => {
    node.depth = depth;
    node.children.sort(sortBySeq);
    for (const c of node.children) assignDepth(c, depth + 1);
  };
  roots.sort(sortBySeq);
  for (const r of roots) assignDepth(r, 0);
  return roots;
}

/** Flatten a forest into a pre-order list (for simple list rendering). */
export function flattenTree(roots: SpanNode[]): SpanNode[] {
  const out: SpanNode[] = [];
  const walk = (n: SpanNode) => { out.push(n); for (const c of n.children) walk(c); };
  for (const r of roots) walk(r);
  return out;
}

/** Sum cost (from llm spans' attributes) grouped by the owning agent span name. */
export function perAgentCost(spans: SpanLike[]): Record<string, number> {
  const byId = new Map<string, SpanLike>();
  for (const s of spans) byId.set(s.id, s);

  const agentNameOf = (s: SpanLike): string => {
    let cur: SpanLike | undefined = s;
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

export function formatCost(usd: number | undefined): string {
  const n = Number(usd ?? 0);
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return "—";
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function round(n: number): number {
  return Math.round(n * 1e12) / 1e12;
}
