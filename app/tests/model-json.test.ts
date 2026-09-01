import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseModelJson } from "../lib/model-json.js";
import {
  decisionSchema,
  reviewerOutputSchema,
} from "../workflows/spec-to-pr/contracts.js";

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

describe("reviewerOutputSchema", () => {
  it("parses structured reviewer output with findings", () => {
    const raw = JSON.stringify({
      findings: [
        {
          severity: "high",
          confidence: 85,
          file: "src/auth.ts",
          description: "Missing input validation",
        },
        {
          severity: "low",
          confidence: 60,
          file: "src/utils.ts",
          description: "Unused variable",
        },
      ],
    });
    const result = parseModelJson(reviewerOutputSchema, raw);
    expect(result).not.toBeNull();
    expect(result?.findings).toHaveLength(2);
    expect(result?.findings[0].severity).toBe("high");
    expect(result?.findings[0].confidence).toBe(85);
  });

  it("accepts an empty findings array", () => {
    const result = parseModelJson(
      reviewerOutputSchema,
      '{"findings":[]}',
    );
    expect(result).toEqual({ findings: [] });
  });

  it("rejects findings with invalid severity", () => {
    const result = parseModelJson(
      reviewerOutputSchema,
      '{"findings":[{"severity":"urgent","confidence":50,"file":"a.ts","description":"x"}]}',
    );
    expect(result).toBeNull();
  });

  it("rejects confidence outside 0-100", () => {
    const result = parseModelJson(
      reviewerOutputSchema,
      '{"findings":[{"severity":"high","confidence":150,"file":"a.ts","description":"x"}]}',
    );
    expect(result).toBeNull();
  });
});

describe("decisionSchema with risk tier and findings", () => {
  it("parses a full judge decision with risk tier and top findings", () => {
    const raw = JSON.stringify({
      decision: "request_changes",
      riskTier: "high",
      summary: "Critical security issue found",
      topFindings: [
        {
          source: "security",
          severity: "critical",
          confidence: 95,
          file: "src/db.ts",
          description: "SQL injection vulnerability",
        },
      ],
    });
    const result = parseModelJson(decisionSchema, raw);
    expect(result).not.toBeNull();
    expect(result?.riskTier).toBe("high");
    expect(result?.topFindings).toHaveLength(1);
    expect(result?.topFindings?.[0].source).toBe("security");
  });

  it("accepts a decision without optional riskTier and topFindings", () => {
    const result = parseModelJson(
      decisionSchema,
      '{"decision":"approve","summary":"looks good"}',
    );
    expect(result).not.toBeNull();
    expect(result?.riskTier).toBeUndefined();
    expect(result?.topFindings).toBeUndefined();
  });

  it("rejects invalid risk tier values", () => {
    const result = parseModelJson(
      decisionSchema,
      '{"decision":"approve","riskTier":"extreme","summary":"x"}',
    );
    expect(result).toBeNull();
  });

  it("rejects invalid source in top findings", () => {
    const result = parseModelJson(
      decisionSchema,
      '{"decision":"approve","summary":"x","topFindings":[{"source":"lint","severity":"low","confidence":50,"file":"a.ts","description":"y"}]}',
    );
    expect(result).toBeNull();
  });
});
