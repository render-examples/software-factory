import type { RunEvent } from "@render-agents/store";
import type { Tracer, SpanInfo, SpanOutcome } from "@render-agents/store";

/**
 * A Tracer implementation that bridges `onStart`/`onEnd` into event
 * emission. Used by workflow contexts and external callers that operate
 * through the Tracer interface rather than emitting events directly.
 *
 * The DefaultRunner's RunContext already emits span-producing events
 * directly (it owns the spanId/parentSpanId correlation). This tracer
 * is for code paths outside the loop that still want tracing — e.g.
 * workflow `ctx.step()` calls, gateway-level observations, or OTel
 * bridging.
 */
export class EventEmittingTracer implements Tracer {
  constructor(private readonly emit: (event: RunEvent) => void) {}

  onStart(span: SpanInfo, input: unknown): void {
    switch (span.kind) {
      case "agent":
        this.emit({ type: "run.started", input });
        break;
      case "tool":
        this.emit({ type: "tool.called", toolCallId: span.spanId, name: span.name, input });
        break;
      case "step":
        this.emit({ type: "step.started", name: span.name });
        break;
      case "llm":
        // LLM spans are emitted as llm.call on end (single event, not start+end)
        break;
      case "workflow":
        this.emit({ type: "run.started", input });
        break;
    }
  }

  onEnd(span: SpanInfo, outcome: SpanOutcome): void {
    switch (span.kind) {
      case "agent":
        if (outcome.ok) {
          this.emit({ type: "run.completed", result: outcome.output });
        } else {
          this.emit({ type: "run.failed", error: outcome.error });
        }
        break;
      case "tool":
        this.emit({
          type: "tool.result",
          toolCallId: span.spanId,
          name: span.name,
          result: outcome.ok
            ? { content: typeof outcome.output === "string" ? outcome.output : JSON.stringify(outcome.output) }
            : { content: outcome.error, isError: true },
        });
        break;
      case "step":
        this.emit({ type: "step.completed", name: span.name, result: outcome.ok ? outcome.output : undefined });
        break;
      case "llm":
        // LLM spans should emit llm.call directly with usage data; this is a fallback
        break;
      case "workflow":
        if (outcome.ok) {
          this.emit({ type: "run.completed", result: outcome.output });
        } else {
          this.emit({ type: "run.failed", error: outcome.error });
        }
        break;
    }
  }
}

/**
 * No-op tracer. Span data is derived entirely from the event log projections;
 * the Tracer interface exists for external callers that want to trace through it.
 * With the no-op tracer, all tracing still works via the RunContext's direct
 * event emission path.
 */
export const noopTracer: Tracer = {
  onStart: () => {},
  onEnd: () => {},
};
