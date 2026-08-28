export type CheckStatus = "pass" | "fail" | "skip" | "warn";

export interface CheckResult {
  category: string;
  label: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

const ICONS: Record<CheckStatus, string> = {
  pass: "\x1b[32m✓\x1b[0m",
  fail: "\x1b[31m✗\x1b[0m",
  skip: "\x1b[90m-\x1b[0m",
  warn: "\x1b[33m⚠\x1b[0m",
};

export function printResults(results: CheckResult[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ checks: results }, null, 2));
    return;
  }

  let currentCategory = "";
  for (const r of results) {
    if (r.category !== currentCategory) {
      if (currentCategory) console.log();
      console.log(`\x1b[1m${r.category}\x1b[0m`);
      currentCategory = r.category;
    }
    const icon = ICONS[r.status];
    const detail = r.detail ? ` (${r.detail})` : "";
    console.log(`  ${icon} ${r.label}${detail}`);
    if (r.fix) {
      console.log(`    → ${r.fix}`);
    }
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const warned = results.filter((r) => r.status === "warn").length;

  console.log();
  const parts = [`${passed} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (warned > 0) parts.push(`${warned} warnings`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  console.log(`Summary: ${parts.join(", ")}`);

  if (failed > 0) {
    for (const r of results.filter((r) => r.status === "fail")) {
      console.log(`  \x1b[31m✗\x1b[0m ${r.label}`);
    }
  }
}
