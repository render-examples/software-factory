import { describe, it, expect } from "vitest";
import { matchesCron, validateCron, parseCron, dueSchedules } from "../src/cron.js";

/** UTC date helper. */
const at = (iso: string) => new Date(iso);

describe("matchesCron", () => {
  it("matches the every-minute wildcard", () => {
    expect(matchesCron("* * * * *", at("2026-06-29T12:34:00Z"))).toBe(true);
  });

  it("matches a specific minute/hour", () => {
    expect(matchesCron("30 4 * * *", at("2026-06-29T04:30:00Z"))).toBe(true);
    expect(matchesCron("30 4 * * *", at("2026-06-29T04:31:00Z"))).toBe(false);
    expect(matchesCron("30 4 * * *", at("2026-06-29T05:30:00Z"))).toBe(false);
  });

  it("supports step values", () => {
    expect(matchesCron("*/15 * * * *", at("2026-06-29T10:00:00Z"))).toBe(true);
    expect(matchesCron("*/15 * * * *", at("2026-06-29T10:15:00Z"))).toBe(true);
    expect(matchesCron("*/15 * * * *", at("2026-06-29T10:07:00Z"))).toBe(false);
  });

  it("supports lists and ranges", () => {
    expect(matchesCron("0 9-17 * * 1-5", at("2026-06-29T09:00:00Z"))).toBe(true); // Mon 09:00
    expect(matchesCron("0 9-17 * * 1-5", at("2026-06-28T09:00:00Z"))).toBe(false); // Sun
    expect(matchesCron("0 0 1,15 * *", at("2026-06-15T00:00:00Z"))).toBe(true);
    expect(matchesCron("0 0 1,15 * *", at("2026-06-14T00:00:00Z"))).toBe(false);
  });

  it("uses OR semantics when both day-of-month and day-of-week are restricted", () => {
    // "13th OR a Friday" — Vixie-cron OR rule.
    const expr = "0 0 13 * 5";
    expect(matchesCron(expr, at("2026-06-13T00:00:00Z"))).toBe(true); // the 13th (a Saturday)
    expect(matchesCron(expr, at("2026-06-05T00:00:00Z"))).toBe(true); // a Friday (not the 13th)
    expect(matchesCron(expr, at("2026-06-06T00:00:00Z"))).toBe(false); // neither
  });

  it("accepts 7 as Sunday", () => {
    expect(matchesCron("0 0 * * 7", at("2026-06-28T00:00:00Z"))).toBe(true); // Sunday
    expect(matchesCron("0 0 * * 0", at("2026-06-28T00:00:00Z"))).toBe(true);
  });
});

describe("validateCron / parseCron", () => {
  it("rejects malformed expressions", () => {
    expect(validateCron("* * * *")).toMatch(/expected 5 fields/);
    expect(validateCron("60 * * * *")).toMatch(/out of range/);
    expect(validateCron("*/0 * * * *")).toMatch(/invalid step/);
    expect(validateCron("5-1 * * * *")).toMatch(/inverted range/);
  });

  it("accepts valid expressions", () => {
    expect(validateCron("*/5 0-23 * * *")).toBeUndefined();
    expect(() => parseCron("0 4 * * *")).not.toThrow();
  });
});

describe("dueSchedules", () => {
  const base = { workflow: "code-review", input: undefined };

  it("selects enabled schedules whose cron matches the current minute", () => {
    const now = at("2026-06-29T04:30:00Z");
    const due = dueSchedules(
      [
        { ...base, id: "a", cronExpression: "30 4 * * *", enabled: true },
        { ...base, id: "b", cronExpression: "31 4 * * *", enabled: true },
        { ...base, id: "c", cronExpression: "30 4 * * *", enabled: false },
      ],
      now,
    );
    expect(due.map((s) => s.id)).toEqual(["a"]);
  });

  it("skips a schedule already fired this minute (idempotent tick)", () => {
    const now = at("2026-06-29T04:30:15Z");
    const due = dueSchedules(
      [{ ...base, id: "a", cronExpression: "30 4 * * *", enabled: true, lastRunAt: "2026-06-29T04:30:02Z" }],
      now,
    );
    expect(due).toHaveLength(0);
  });

  it("fires again in a later matching minute", () => {
    const now = at("2026-06-29T04:31:00Z");
    const due = dueSchedules(
      [{ ...base, id: "a", cronExpression: "*/1 * * * *", enabled: true, lastRunAt: "2026-06-29T04:30:00Z" }],
      now,
    );
    expect(due.map((s) => s.id)).toEqual(["a"]);
  });

  it("never throws on an invalid cron expression (skips it)", () => {
    const now = at("2026-06-29T04:30:00Z");
    expect(() => dueSchedules([{ ...base, id: "bad", cronExpression: "nonsense", enabled: true }], now)).not.toThrow();
    expect(dueSchedules([{ ...base, id: "bad", cronExpression: "nonsense", enabled: true }], now)).toHaveLength(0);
  });
});
