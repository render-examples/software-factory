# 01 — Characterization / parity oracle

**Status:** DONE (spike, 2026-07-17) — generation + certification validated live on `leven`. See "Result" below.
**Maps to:** spec §5.1, §10; research Track B (`../../research/B-characterization-tests.md`); corpus (`../../research/corpus.md`)
**De-risks:** the single most load-bearing, least-proven capability — **auto-generating a *trustworthy* parity oracle**, especially for repos with weak/no existing tests.

## Result (spike, 2026-07-17)

Built on the native engine (`epic-2/01-characterization` branch): `oracle.ts` (pure certification: determinism check + mutation battery + gates, 13 unit tests), a `characterizer` agent, a `characterize` workflow (clone → generate → source-pristine guard → certify), and a curated leven mutant battery.

**Live run on `leven` (`node --test` oracle, model `claude-sonnet-4-6`):**
- **Generation:** characterizer produced a **34-case** oracle (identical/empty/single-edit/transposition/trim/classic/symmetry/unicode + `maxDistance` + `closestMatch`), all green vs. unmodified source — derived independently, ignoring leven's own `ava` suite.
- **G0 determinism:** 20/20 runs green.
- **G2 mutation:** score **0.75** — killed 3/4 curated mutants; **1 survived** (`dp-branch-a-off-by-one`: `result + 1 → result + 2`).
- **`certification.ok: true`.**

**Key finding (validates the Track B thesis):** the oracle looked complete by coverage (34 passing tests) yet mutation testing **surfaced a real gap** — a genuine behavioral mutation the oracle failed to catch. Certification has teeth; coverage alone would have rubber-stamped it.

**Follow-ups (deferred):** (1) **mutation-feedback loop** — feed surviving mutants back to the characterizer to strengthen the corpus (MutGen-style, Track B) rather than accept a marginal 0.75; (2) full StrykerJS/mutmut for open-ended mutation coverage; (3) from-scratch on a no-tests repo (`pygit`) + determinism shims for real I/O; (4) wire the generated oracle into `leven-migrate`'s parity gate (differential source-vs-migrated).

## Goal

Prove code-migrator can **synthesize a parity oracle** (characterization tests capturing a repo's observable behavior) and use it to verify a migration — *without* relying on the repo's pre-existing tests. Success is a **trusted** oracle, measured by mutation score + determinism, not just "a green suite."

## Context

M0.5 proved the native coding loop but **used leven's existing `ava` suite as the oracle** — dodging the hard part. The real system must generate the oracle itself. Track B's load-bearing findings shape this ticket:

- Parity is a **differential** problem (source vs. migrated on identical inputs); the portable artifact is **frozen golden files** (input corpus + scrubbed golden outputs).
- **Coverage is a weak trust signal; mutation score is the real one** (100%-coverage/4%-mutation is a real outcome).
- **Determinism is a prerequisite** (frozen clock, seeded RNG, VCR-style I/O record/replay, stable/unstable field classification) — a flaky oracle is worthless.
- The dominant failure mode is a **gamed or brittle** oracle → it must be **source-owned and read-only to the migrator**, graded by structured reports.

## Scope

**In:**
- A characterization-generation loop (native engine + `workspace` tools) over a checked-out **source** repo.
- A **mutation-score gate** to certify oracle strength.
- **Determinism** shims + an N-rerun stability check.
- A **differential parity check** (run the oracle's input corpus against the migrated target, compare scrubbed outputs) — replacing M0.5's "reuse existing tests" step in `leven-migrate`.

**Out (deferred to later tickets):**
- Dependency graph, slicing, multi-slice DAG (whole small repo = one slice here).
- Full language matrix. **Start JS→TS (same-language behavior capture) to isolate the characterization variable**, then Python. Cross-language *differential* harness (Py source vs Go target) is a stretch goal / follow-up.

## Design

1. **`characterizer` agent** (`agents/characterizer.md`, native `DefaultRunner`, `tools: [workspace]`): given `repoDir` (source), explore the public API, generate a representative **input corpus**, execute the source to capture **golden outputs**, and emit runnable characterization tests + golden files. Applies determinism discipline before capture (inject/freeze clock, seed PRNGs, record/replay I/O; classify each output field stable/unstable and scrub unstable ones).
2. **`characterize` workflow** (`workflows/characterize/index.ts`): checkout source → run `characterizer` → **certify**:
   - **G0 determinism:** run the generated oracle **≥20×**, require all green, no live network.
   - **G2 mutation:** run a mutation tester on the source (StrykerJS for JS/TS; `mutmut`/`cosmic-ray` for Python) via `workspace__exec`; require mutation score **≥ threshold** (start ~75%, calibrate) with surviving mutants triaged.
   - **G3 independence:** oracle generated from source only; stored **read-only** to the migrator; grading via structured report (no stdout scraping).
   - Store the oracle (input corpus + scrubbed goldens + field classification) as the slice's must-preserve artifact (spec §8.4).
3. **Differential parity:** extend `src/lib/parity.ts` so the behavior gate runs the **generated oracle** against the migrated target (same corpus → compare scrubbed outputs), not the repo's `npm test`. Keep the existing gate structure (artifact, deps, typecheck, behavior).

## Deliverables

- `agents/characterizer.md`
- `workflows/characterize/index.ts` (+ wire into / alongside `leven-migrate`)
- Mutation-scoring step (Stryker/mutmut invoked via `workspace__exec`), surfaced as a gate
- Determinism helpers/guidance + the N-rerun stability check
- Golden-oracle storage format (documented) + read-only enforcement
- `src/lib/parity.ts` extended for the differential/generated-oracle path (pure, unit-tested)
- Short doc: how the oracle is generated, certified, and consumed

## Acceptance

- **Ground-truth validation** (on a repo that HAS a trusted suite — leven or python-slugify): generate our oracle **ignoring** the existing tests; our oracle (a) is deterministic (G0), (b) achieves the mutation-score bar (G2), and (c) **catches an injected behavioral regression** that the existing suite also catches.
- **From-scratch validation** (on `pygit`, no tests): generate an oracle; apply determinism shims for fs/zlib/SHA/network; pass G0 + G2 (or cleanly escalate genuinely-nondeterministic parts to a human-review path).
- **End-to-end:** for one corpus repo, generate oracle → migrate → **differential parity green**.
- typecheck + unit tests green; runnable via a script like M0.5's `spike-run.sh`.

## Risks / open questions

- **From-scratch yield:** TestGen-LLM only demonstrated ~10% *augmentation* on repos that already had tests; generating a whole trustworthy oracle is harder — validate empirically and define the fallback when a repo can't clear G2 (narrow scope / manual seed).
- **Determinism for real side effects:** `pygit`'s network push / SHA / zlib — define the record/replay approach and the human-review path for parts that can't be made deterministic.
- **Mutation-testing cost/time** per repo — needs a budget model / tiering (full gate on high-fan-in slices, lighter on leaves).
- **Cross-language differential** (Py source vs Go target running the same corpus): needs a language-agnostic harness or per-language adapters — likely a follow-up; this ticket proves the mechanism same-language first.
- **Oracle-gaming**: enforce read-only oracle + clean-container grading from day one.
