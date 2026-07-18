// Oracle certification for the characterization / parity-oracle spike. Pure +
// dependency-injected so determinism + mutation-battery logic is unit-testable
// without a real shell or filesystem. Gates decide whether a generated oracle is
// trustworthy before it is used in live characterization workflows.
import { join } from "node:path";

export interface OracleExecDeps {
  exec(cmd: string, cwd: string): Promise<{ code: number; output: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface DeterminismResult {
  ok: boolean;
  runs: number;
  greenRuns: number;
  detail: string;
}

export interface Mutant {
  id: string;
  file: string;
  find: string;
  replace: string;
}

export interface MutationResult {
  score: number;
  killed: string[];
  survived: string[];
  errored: string[];
  detail: string;
}

export interface GateResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface OracleCertification {
  ok: boolean;
  gates: GateResult[];
}

/** Run the oracle command `runs` times (default 20); ok iff all exit 0. */
export async function runDeterminismCheck(
  testCmd: string,
  cwd: string,
  deps: OracleExecDeps,
  opts?: { runs?: number },
): Promise<DeterminismResult> {
  const runs = opts?.runs ?? 20;
  let greenRuns = 0;

  for (let i = 1; i <= runs; i++) {
    const result = await deps.exec(testCmd, cwd);
    if (result.code === 0) {
      greenRuns++;
      continue;
    }
    return {
      ok: false,
      runs,
      greenRuns,
      detail: `$ ${testCmd} run ${i}/${runs} (exit ${result.code})\n${result.output}`,
    };
  }

  return {
    ok: true,
    runs,
    greenRuns,
    detail: `${runs}/${runs} runs passed (exit 0)`,
  };
}

function mutationScore(killed: string[], survived: string[]): number {
  const runnable = killed.length + survived.length;
  if (runnable === 0) return 0;
  return killed.length / runnable;
}

function summarizeMutationBattery(
  killed: string[],
  survived: string[],
  errored: string[],
  score: number,
): string {
  const parts = [
    `score ${score} (${killed.length} killed, ${survived.length} survived, ${errored.length} errored)`,
  ];
  if (killed.length) parts.push(`killed: ${killed.join(", ")}`);
  if (survived.length) parts.push(`survived: ${survived.join(", ")}`);
  if (errored.length) parts.push(`errored: ${errored.join(", ")}`);
  return parts.join("\n");
}

/**
 * For each mutant: read file → apply find→replace (must change content, else
 * `errored`) → run testCmd → non-zero exit = killed, zero = survived → ALWAYS
 * restore the file.
 */
export async function runMutationBattery(
  repoDir: string,
  testCmd: string,
  mutants: Mutant[],
  deps: OracleExecDeps,
): Promise<MutationResult> {
  const killed: string[] = [];
  const survived: string[] = [];
  const errored: string[] = [];

  for (const mutant of mutants) {
    const filePath = join(repoDir, mutant.file);
    let original: string;

    try {
      original = await deps.readFile(filePath);
    } catch (err) {
      errored.push(mutant.id);
      continue;
    }

    if (!original.includes(mutant.find) || mutant.replace === mutant.find) {
      errored.push(mutant.id);
      continue;
    }

    const mutated = original.replace(mutant.find, mutant.replace);

    try {
      await deps.writeFile(filePath, mutated);

      try {
        const result = await deps.exec(testCmd, repoDir);
        if (result.code !== 0) {
          killed.push(mutant.id);
        } else {
          survived.push(mutant.id);
        }
      } catch {
        errored.push(mutant.id);
      }
    } finally {
      await deps.writeFile(filePath, original);
    }
  }

  const score = mutationScore(killed, survived);
  return {
    score,
    killed,
    survived,
    errored,
    detail: summarizeMutationBattery(killed, survived, errored, score),
  };
}

/** G0 determinism + G2 mutation-score (≥ minMutationScore, default 0.75). */
export function certifyOracle(
  det: DeterminismResult,
  mut: MutationResult,
  opts?: { minMutationScore?: number },
): OracleCertification {
  const minMutationScore = opts?.minMutationScore ?? 0.75;
  const gates: GateResult[] = [
    {
      name: "G0: determinism",
      ok: det.ok,
      detail: det.detail,
    },
    {
      name: "G2: mutation score",
      ok: mut.score >= minMutationScore,
      detail: `${mut.detail}\nthreshold ≥ ${minMutationScore}`,
    },
  ];

  return { ok: gates.every((g) => g.ok), gates };
}
