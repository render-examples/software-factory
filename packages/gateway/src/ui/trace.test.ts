import { describe, it, expect } from "vitest";
import { buildSpanTree, flattenTree, perAgentCost, formatCost, formatDuration, type SpanLike } from "./trace.js";

const spans: SpanLike[] = [
  { id: "wf", seq: 1, name: "code-review", kind: "workflow", status: "ok" },
  { id: "sec", parentId: "wf", seq: 2, name: "security", kind: "agent", status: "ok" },
  { id: "sec-llm", parentId: "sec", seq: 3, name: "claude", kind: "llm", status: "ok", attributes: { costUsd: 0.002 } },
  { id: "perf", parentId: "wf", seq: 4, name: "performance", kind: "agent", status: "ok" },
  { id: "perf-llm", parentId: "perf", seq: 5, name: "claude", kind: "llm", status: "ok", attributes: { costUsd: 0.003 } },
];

describe("buildSpanTree", () => {
  it("nests by parentId and orders by seq with depth", () => {
    const roots = buildSpanTree(spans);
    expect(roots).toHaveLength(1);
    expect(roots[0].id).toBe("wf");
    expect(roots[0].children.map((c) => c.id)).toEqual(["sec", "perf"]);
    const flat = flattenTree(roots);
    expect(flat.map((n) => n.id)).toEqual(["wf", "sec", "sec-llm", "perf", "perf-llm"]);
    expect(flat.find((n) => n.id === "sec-llm")!.depth).toBe(2);
  });

  it("treats spans with unknown parents as roots", () => {
    const roots = buildSpanTree([{ id: "orphan", parentId: "missing", seq: 1, name: "x", kind: "tool", status: "ok" }]);
    expect(roots.map((r) => r.id)).toEqual(["orphan"]);
  });
});

describe("perAgentCost", () => {
  it("attributes llm cost to the enclosing agent", () => {
    expect(perAgentCost(spans)).toEqual({ security: 0.002, performance: 0.003 });
  });
});

describe("formatters", () => {
  it("formats cost and duration", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0023)).toBe("$0.0023");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatDuration("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.500Z")).toBe("500ms");
    expect(formatDuration("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:02.000Z")).toBe("2.0s");
    expect(formatDuration(undefined)).toBe("—");
  });
});
