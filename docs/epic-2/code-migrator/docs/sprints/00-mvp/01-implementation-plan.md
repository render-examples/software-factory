# 01 — Implementation plan (characterization / parity oracle)

Buildable decomposition of ticket `01-characterization-parity-oracle.md`, following the M0.5 flow (plan → composer subagents → review → prove live). Built on the render-agents native engine (`examples/demo`), branch off the code-migrator spike branch.

## Spike focus (isolate the big risk)

Prove **"can we synthesize a *trustworthy* parity oracle?"** — the least-proven capability — on the smallest surface:

- Target **leven (JS)**, **same-language** (generate a JS characterization oracle for the JS source). No migration needed: the differential-against-migrated step is already proven by M0.5. This isolates *oracle generation + trust* from the language gap.
- Trust signal = **determinism** (N green reruns) + a **seeded mutation battery** (inject known behavioral mutants into the source, measure kill rate). Full StrykerJS is the production scale-up (noted, deferred) — a curated mutant battery is faster, deterministic, and repeatable for the spike, and directly answers "does the oracle pin behavior."
- Ground truth: leven *has* a trusted `ava` suite; we generate our own oracle **ignoring it** and show ours kills the mutant battery (and by extension would catch regressions).

## Scope boundary (environment)

Live runs need `ANTHROPIC_API_KEY` (in `examples/demo/.env`) + network + real tokens. Code + typecheck + **mocked unit tests** run in-sandbox. The certification module is pure/injected so its logic is fully unit-tested without a model or shell.

## Decomposition

### Round 1 — Oracle-certification module (one composer subagent)

`examples/demo/src/lib/oracle.ts` — pure, dependency-injected:

```ts
export interface OracleExecDeps {
  exec(cmd: string, cwd: string): Promise<{ code: number; output: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface DeterminismResult { ok: boolean; runs: number; greenRuns: number; detail: string; }
/** Run the oracle command `runs` times (default 20); ok iff all exit 0. */
export function runDeterminismCheck(testCmd: string, cwd: string, deps: OracleExecDeps, opts?: { runs?: number }): Promise<DeterminismResult>;

/** A behavioral mutant = a find/replace on a source file. */
export interface Mutant { id: string; file: string; find: string; replace: string; }
export interface MutationResult { score: number; killed: string[]; survived: string[]; errored: string[]; detail: string; }
/**
 * For each mutant: read file → apply find→replace (must change content, else `errored`) →
 * run testCmd → non-zero exit = killed, zero = survived → ALWAYS restore the file.
 * score = killed / (killed + survived).
 */
export function runMutationBattery(repoDir: string, testCmd: string, mutants: Mutant[], deps: OracleExecDeps): Promise<MutationResult>;

export interface GateResult { name: string; ok: boolean; detail: string; }
export interface OracleCertification { ok: boolean; gates: GateResult[]; }
/** G0 determinism + G2 mutation-score(≥ minMutationScore, default 0.75). Both load-bearing. */
export function certifyOracle(det: DeterminismResult, mut: MutationResult, opts?: { minMutationScore?: number }): OracleCertification;
```

Vitest (`tests/oracle.test.ts`) with fake deps: determinism 20/20 green → ok, one non-zero → not ok; mutation battery kills/survives/restores (assert file restored even on throw); certify thresholds + gate names. **No network/model.**

**Acceptance:** `pnpm --filter @render-agents/example-demo typecheck` + `test` green.

### Round 2 — Characterizer agent + workflow + battery + tooling (composer subagent[s], after R1 review)

- `agents/characterizer.md` — native (`DefaultRunner`, `tools: [workspace]`). Prompt: given `repoDir`, generate a **deterministic characterization test** that imports the public API and asserts golden outputs over a representative input corpus (seed any RNG, avoid wall-clock/network). Write it as a runnable file and **report the exact test command** (e.g. `node --test characterization.test.mjs`). Read the source before writing; do not modify source.
- `workflows/characterize/index.ts` — clone target (default leven) into the workspace root → `ctx.agents.get("characterizer").run({ repoDir })` → parse the reported test command → `runDeterminismCheck` → `runMutationBattery` (leven mutant battery) → `certifyOracle` → return `{ oracleCommand, certification }`. Use `runShell` from `workspace.ts` for the exec dep; `node:fs` for read/write/restore.
- `workflows/characterize/leven-mutants.ts` (or inline) — a curated **leven mutant battery** (e.g. flip a `<`/`<=`, swap `+`/`-` in the cost calc, off-by-one) that a correct oracle must kill.
- `scripts/spike-characterize.sh` — boot gateway (memory store), dispatch `characterize`, print the certification result + oracle command. Mirror `spike-run.sh`.
- Short doc: how the oracle is generated + certified + where goldens live.

**Acceptance:** typecheck + tests green; workflow registers via `loadProject`.

## Review gates (parent)

After each round: read every file, run typecheck + tests, scrutinize — file **restore guarantee** in the mutation battery (must restore on failure/throw), determinism runner honesty (no false green), gate math (score rounding, empty-battery guard), no source mutation leaking, injected-deps purity, repo conventions.

## Live proof (on `leven`, gated on credentials)

1. Dispatch `characterize` → characterizer generates the oracle; determinism 20/20; mutation battery **kill rate ≥ 0.75**; `certification.ok === true`.
2. Ground-truth cross-check: confirm the generated oracle also fails on a hand-injected regression outside the battery.
3. Record the mutation score + a sample of the generated oracle in the ticket.

## Out of scope (later tickets)

Full StrykerJS/mutmut; cross-language differential (Py→Go); no-tests repo (`pygit`) from-scratch; determinism shims for real I/O/network; wiring the generated oracle into `leven-migrate`'s parity gate (follow-up once generation is trusted).
