import { describe, it, expect } from "vitest";
import { HookInterceptor, type Hook, type HookContext } from "../hooks.js";
import type { AgentEvent } from "../runner.js";

const ctx: HookContext = { runId: "test-run", agentId: "test-agent" };

function toolCallEvent(name = "Bash", input: Record<string, unknown> = { command: "ls" }): AgentEvent {
  return { type: "tool_call", id: "tc-1", name, input };
}

function resultEvent(result = "hello"): AgentEvent {
  return { type: "result", result };
}

function textEvent(text = "thinking..."): AgentEvent {
  return { type: "text", text };
}

describe("HookInterceptor", () => {
  it("passes events through with no hooks", async () => {
    const interceptor = new HookInterceptor([]);
    const result = await interceptor.intercept(toolCallEvent(), ctx);
    expect(result.action).toBe("continue");
    expect(result).not.toHaveProperty("event");
  });

  it("observe hook passes events unchanged", async () => {
    const seen: string[] = [];
    const hook: Hook = {
      name: "observer",
      on: ["tool_call"],
      async handle(event) {
        seen.push(event.type);
        return { action: "continue" };
      },
    };
    const interceptor = new HookInterceptor([hook]);
    const result = await interceptor.intercept(toolCallEvent(), ctx);
    expect(result.action).toBe("continue");
    expect(result).not.toHaveProperty("event");
    expect(seen).toEqual(["tool_call"]);
  });

  it("transform hook rewrites event", async () => {
    const hook: Hook = {
      name: "redactor",
      on: ["result"],
      async handle(event) {
        if (event.type === "result") {
          return { action: "continue", event: { ...event, result: "[REDACTED]" } };
        }
        return { action: "continue" };
      },
    };
    const interceptor = new HookInterceptor([hook]);
    const result = await interceptor.intercept(resultEvent("secret-key-123"), ctx);
    expect(result.action).toBe("continue");
    if (result.action === "continue") {
      expect(result.event).toEqual({ type: "result", result: "[REDACTED]" });
    }
  });

  it("veto hook rejects tool_call", async () => {
    const hook: Hook = {
      name: "blocker",
      on: ["tool_call"],
      async handle() {
        return { action: "reject", reason: "blocked by policy" };
      },
    };
    const interceptor = new HookInterceptor([hook]);
    const result = await interceptor.intercept(toolCallEvent(), ctx);
    expect(result.action).toBe("reject");
    if (result.action === "reject") {
      expect(result.reason).toBe("blocked by policy");
    }
  });

  it("veto on non-tool_call is ignored (fail-open)", async () => {
    const hook: Hook = {
      name: "bad-veto",
      on: ["result"],
      async handle() {
        return { action: "reject", reason: "should be ignored" };
      },
    };
    const interceptor = new HookInterceptor([hook]);
    const result = await interceptor.intercept(resultEvent(), ctx);
    expect(result.action).toBe("continue");
  });

  it("throw on tool_call fails closed (reject)", async () => {
    const hook: Hook = {
      name: "crasher",
      on: ["tool_call"],
      async handle() {
        throw new Error("hook crashed");
      },
    };
    const interceptor = new HookInterceptor([hook]);
    const result = await interceptor.intercept(toolCallEvent(), ctx);
    expect(result.action).toBe("reject");
    if (result.action === "reject") {
      expect(result.reason).toContain("hook crashed");
    }
  });

  it("throw on text/result fails open (continue)", async () => {
    const hook: Hook = {
      name: "crasher",
      on: ["text", "result"],
      async handle() {
        throw new Error("hook crashed");
      },
    };
    const interceptor = new HookInterceptor([hook]);

    const textResult = await interceptor.intercept(textEvent(), ctx);
    expect(textResult.action).toBe("continue");

    const resultResult = await interceptor.intercept(resultEvent(), ctx);
    expect(resultResult.action).toBe("continue");
  });

  it("hooks run in order, transforms chain", async () => {
    const hook1: Hook = {
      name: "upper",
      on: ["result"],
      async handle(event) {
        if (event.type === "result") {
          return { action: "continue", event: { ...event, result: event.result.toUpperCase() } };
        }
        return { action: "continue" };
      },
    };
    const hook2: Hook = {
      name: "suffix",
      on: ["result"],
      async handle(event) {
        if (event.type === "result") {
          return { action: "continue", event: { ...event, result: `${event.result}!` } };
        }
        return { action: "continue" };
      },
    };
    const interceptor = new HookInterceptor([hook1, hook2]);
    const result = await interceptor.intercept(resultEvent("hello"), ctx);
    expect(result.action).toBe("continue");
    if (result.action === "continue") {
      expect(result.event).toEqual({ type: "result", result: "HELLO!" });
    }
  });

  it("hook only fires for matching event types", async () => {
    const seen: string[] = [];
    const hook: Hook = {
      name: "tool-only",
      on: ["tool_call"],
      async handle(event) {
        seen.push(event.type);
        return { action: "continue" };
      },
    };
    const interceptor = new HookInterceptor([hook]);
    await interceptor.intercept(resultEvent(), ctx);
    await interceptor.intercept(textEvent(), ctx);
    await interceptor.intercept(toolCallEvent(), ctx);
    expect(seen).toEqual(["tool_call"]);
  });
});
