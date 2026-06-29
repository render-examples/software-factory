/**
 * Minimal standard 5-field cron evaluator for runtime-managed schedules.
 *
 * Fields (UTC): `minute hour day-of-month month day-of-week`.
 *   minute       0-59
 *   hour         0-23
 *   day-of-month 1-31
 *   month        1-12
 *   day-of-week  0-6   (0 = Sunday; 7 is accepted as Sunday too)
 *
 * Each field supports `*`, lists (`a,b`), ranges (`a-b`), and steps (`* /n`,
 * `a-b/n`). Day-of-month / day-of-week follow Vixie-cron semantics: when *both*
 * are restricted, a tick matches if *either* matches (OR); otherwise the
 * restricted ones AND together (a `*` field always matches).
 *
 * Resolution is minute-granular — the reconciler is driven by a per-minute
 * tick, so seconds are not modeled.
 */

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELD_BOUNDS: Array<[min: number, max: number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day-of-month
  [1, 12], // month
  [0, 6], // day-of-week
];

/** Parse one cron field into the set of allowed integers within [min,max]. */
function parseField(field: string, min: number, max: number, fieldIndex: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`cron: invalid step "${stepPart}" in field "${field}"`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*" || rangePart === "") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`cron: invalid value "${rangePart}" in field "${field}"`);
    }
    // day-of-week: accept 7 as Sunday (0).
    if (fieldIndex === 4) {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo > hi) throw new Error(`cron: inverted range "${rangePart}" in field "${field}"`);
    if (lo < min || hi > max) throw new Error(`cron: value out of range "${rangePart}" in field "${field}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field cron expression. Throws on malformed input. */
export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron: expected 5 fields, got ${fields.length} in "${expression}"`);
  }
  const [minute, hour, dom, month, dow] = fields.map((f, i) =>
    parseField(f, FIELD_BOUNDS[i][0], FIELD_BOUNDS[i][1], i),
  );
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

/** True when `date` (evaluated in UTC) satisfies the cron expression. */
export function matchesCron(expression: string, date: Date): boolean {
  const spec = parseCron(expression);
  if (!spec.minute.has(date.getUTCMinutes())) return false;
  if (!spec.hour.has(date.getUTCHours())) return false;
  if (!spec.month.has(date.getUTCMonth() + 1)) return false;

  const domOk = spec.dom.has(date.getUTCDate());
  const dowOk = spec.dow.has(date.getUTCDay());
  // Vixie-cron: both restricted → OR; otherwise the restricted field(s) AND.
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

/** Validate a cron expression, returning an error message or undefined. */
export function validateCron(expression: string): string | undefined {
  try {
    parseCron(expression);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Floor a timestamp (ms or ISO) to its minute, as epoch ms. */
function floorToMinute(ts: string | number): number {
  const ms = typeof ts === "number" ? ts : Date.parse(ts);
  return Math.floor(ms / 60_000) * 60_000;
}

/**
 * Select the schedules that are due to fire at `now`: enabled, cron matches the
 * current minute, and not already fired in this same minute (idempotent under
 * tick retries / overlapping ticks). Invalid cron expressions are skipped (the
 * caller logs them); they never throw out of the reconcile pass.
 */
export function dueSchedules<T extends { cronExpression: string; enabled: boolean; lastRunAt?: string }>(
  schedules: T[],
  now: Date,
): T[] {
  const thisMinute = floorToMinute(now.getTime());
  return schedules.filter((s) => {
    if (!s.enabled) return false;
    let matches = false;
    try {
      matches = matchesCron(s.cronExpression, now);
    } catch {
      return false;
    }
    if (!matches) return false;
    if (s.lastRunAt && floorToMinute(s.lastRunAt) >= thisMinute) return false;
    return true;
  });
}
