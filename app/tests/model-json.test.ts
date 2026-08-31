import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseModelJson } from "../lib/model-json.js";

const schema = z.object({ decision: z.enum(["approve", "request_changes"]) });

describe("parseModelJson", () => {
  it("parses strict JSON", () => {
    expect(parseModelJson(schema, '{"decision":"approve"}')).toEqual({
      decision: "approve",
    });
  });

  it("extracts fenced or prose-wrapped JSON", () => {
    expect(
      parseModelJson(
        schema,
        'Result:\n```json\n{"decision":"request_changes"}\n```',
      ),
    ).toEqual({ decision: "request_changes" });
  });

  it("fails closed on invalid output", () => {
    expect(parseModelJson(schema, "looks good")).toBeNull();
    expect(parseModelJson(schema, '{"decision":"ship"}')).toBeNull();
  });
});
