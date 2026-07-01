/*
 * Trace helpers for the operator UI. These are re-exported from the gateway's
 * shared, unit-tested implementation (`src/ui/trace.ts`) so the span-tree and
 * cost algorithms live in exactly one place. The module is pure/browser-safe,
 * so importing it into the SPA bundle is fine.
 */
export {
  buildSpanTree,
  perAgentCost,
  spanCostUsd,
  flattenTree,
  type SpanLike,
  type SpanNode,
} from "../../../src/ui/trace";
