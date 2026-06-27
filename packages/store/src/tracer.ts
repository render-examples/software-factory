export type SpanKind = "workflow" | "agent" | "llm" | "tool" | "step";

export interface SpanInfo {
  spanId: string;
  parentSpanId?: string;
  runId: string;
  name: string;
  kind: SpanKind;
}

export type SpanOutcome =
  | { ok: true; output: unknown }
  | { ok: false; error: string };

export interface Tracer {
  onStart(span: SpanInfo, input: unknown): void;
  onEnd(span: SpanInfo, outcome: SpanOutcome): void;
}

export type SpanStatus = "running" | "ok" | "error";
