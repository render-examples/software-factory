# Research — Code Migrator

Purpose: **de-risk the load-bearing assumptions** in [`../spec.md`](../spec.md) before we plan and decompose the build. This is not a generic literature review — each track exists to answer a specific question that, if answered "no," would change the architecture.

## How to use this folder

- Each track (`A`–`G`) is one focused question with a dedicated doc.
- Every track doc uses the same template: **Question → Why it's load-bearing → Sources to review → Findings → Recommendation → Open items**.
- The **Findings + Recommendation** sections are the deliverable. They feed directly into Planning (spec §7.1 Phase 2) and the eventual DAG decomposition.
- `corpus.md` defines the concrete example repos we migrate to anchor planning and eval.

## Tracks → spec risk mapping

| Track | Topic | De-risks (spec ref) | Mode |
| --- | --- | --- | --- |
| [A](A-harness-reality-check.md) | Harness reality-check (opencode headless + `subagent_type` + Render Workflows) | §6.2–6.3, §11.1 | Empirical spike + docs |
| [B](B-characterization-tests.md) | Characterization test generation (the parity oracle) | §5.1, §10, §13 (coverage) | Reading + prototype |
| [C](C-code-graph-repo-map.md) | Code graph & repo map (tree-sitter/LSP/SCIP + PageRank) | §8, §13 (extraction, freshness) | Reading + prototype |
| [D](D-slicing-strategy.md) | Slicing strategy (cutting the DAG) | §7.2, §8.1, §13 (boundary quality) | Reading |
| [E](E-prior-art-migration.md) | Prior art in automated/agentic migration at scale | §3 approach, §13 | Reading |
| [F](F-dependency-substitution.md) | Cross-language dependency substitution | §13 | Reading |
| [G](G-durable-orchestration.md) | Durable orchestration patterns | §6.3, §7.2, §11.1 | Reading |

## Priority order

1. **Track A** is highest architectural risk and partly empirical — validate the harness claims early (some may already be stale vs. the spec's snapshot).
2. **Track B** is the hardest AI problem (auto-generating the parity oracle) and least-proven part of the spec — invest heavily.
3. Tracks **C–G** are reading-based and fan out well in parallel.

## Local assets worth mining

Sibling projects in this workspace likely hold reusable patterns:
- `../../../agent-workflows-template/` — has a working `render.yaml` + Workflows `src/` (Track A, G).
- `../../../render-agents/`, `../../../render-agent-harness/`, `../../../render-agent-library/` — agent harness + Render integration patterns (Track A).

## Status

All tracks complete (2026-07-17). Cross-track conclusions in [`SYNTHESIS.md`](SYNTHESIS.md).

| Track | Owner | Status |
| --- | --- | --- |
| A | | complete |
| B | | complete |
| C | | complete |
| D | | complete |
| E | | complete |
| F | | complete |
| G | | complete |
| corpus | | complete |
