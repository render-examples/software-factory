// Parity oracle for the JS→TS migration spike. Pure + dependency-injected so it
// can be unit-tested without a real filesystem or child processes. Gates run in
// order and fail fast; parity is green ONLY if every gate passes. The first gate
// (index.ts must exist) is what prevents a false positive: an unmigrated clone
// whose JS test suite still passes must NOT be reported as parity-green.
import { join } from "node:path";

export interface GateResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ParityResult {
  ok: boolean;
  output: string;
  gates: GateResult[];
}

export interface ParityDeps {
  /** True if a path exists in the checkout. */
  exists(path: string): Promise<boolean>;
  /** Run a command in `cwd`; a non-zero `code` is data, not a throw. */
  exec(cmd: string, cwd: string): Promise<{ code: number; output: string }>;
}

export interface ParityOptions {
  /**
   * Command for the behavior gate. Defaults to `npm test`, but parity is about
   * *observable behavior*, not lint style — so callers should point this at the
   * behavior/characterization test runner (e.g. `npx ava`) rather than a
   * `npm test` that bundles a linter.
   */
  testCommand?: string;
}

export function renderGates(gates: GateResult[]): string {
  return gates
    .map((g) => `[${g.ok ? "PASS" : "FAIL"}] ${g.name}\n${g.detail}`)
    .join("\n\n");
}

function finalize(gates: GateResult[]): ParityResult {
  return { ok: gates.every((g) => g.ok), output: renderGates(gates), gates };
}

export async function runParityCheck(
  repoPath: string,
  deps: ParityDeps,
  opts: ParityOptions = {},
): Promise<ParityResult> {
  const testCommand = opts.testCommand ?? "npm test";
  const gates: GateResult[] = [];

  // Gate 1 — migration artifact: index.ts must exist, else no port occurred.
  const hasIndexTs = await deps.exists(join(repoPath, "index.ts"));
  gates.push({
    name: "artifact: index.ts exists",
    ok: hasIndexTs,
    detail: hasIndexTs ? "found index.ts" : "no index.ts — migration did not occur",
  });
  if (!hasIndexTs) return finalize(gates);

  // Gate 2 — dependencies: parity commands need node_modules. Install if absent.
  if (await deps.exists(join(repoPath, "node_modules"))) {
    gates.push({ name: "deps: node_modules present", ok: true, detail: "node_modules already present — skipping install" });
  } else {
    const install = await deps.exec("npm install", repoPath);
    const ok = install.code === 0;
    gates.push({ name: "deps: npm install", ok, detail: `$ npm install (exit ${install.code})\n${install.output}` });
    if (!ok) return finalize(gates);
  }

  // Gate 3 — TypeScript compile: a real port produces a tsconfig.json.
  if (!(await deps.exists(join(repoPath, "tsconfig.json")))) {
    gates.push({
      name: "typecheck: tsconfig.json exists",
      ok: false,
      detail: "no tsconfig.json — a TypeScript migration should produce one",
    });
    return finalize(gates);
  }
  const tsc = await deps.exec("npx tsc --noEmit", repoPath);
  gates.push({ name: "typecheck: npx tsc --noEmit", ok: tsc.code === 0, detail: `$ npx tsc --noEmit (exit ${tsc.code})\n${tsc.output}` });
  if (tsc.code !== 0) return finalize(gates);

  // Gate 4 — behavior: the existing behavior/characterization tests must pass.
  const test = await deps.exec(testCommand, repoPath);
  gates.push({
    name: `behavior: ${testCommand}`,
    ok: test.code === 0,
    detail: `$ ${testCommand} (exit ${test.code})\n${test.output}`,
  });

  return finalize(gates);
}
