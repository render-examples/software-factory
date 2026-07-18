# Epic-2 (code-migrator) — MVP sprint plan

Decomposition of the migration system into assignable tickets, built on the
epic-1 render-agents platform (`D-BASE`) with coding roles on the native engine
(`D-NATIVE`). Grounded in the spec (`../../spec.md`), research (`../../research/`),
and the decisions log (`../../research/DECISIONS.md`).

## Build order (risk-first, not pipeline order)

We deliberately sequence by **de-risking**, not by the Phase 0→5 pipeline order.
The parity oracle is the least-proven, most load-bearing capability (research
Track B; the M0.5 spike dodged it by reusing existing tests), so it comes first.

| # | Ticket | Maps to | De-risks | Status |
| --- | --- | --- | --- | --- |
| 00 | Harness spike | M0.5 | native coding loop + parity gate | ✅ done (`../../spikes/M0.5-harness-spike.md`) |
| 01 | **Characterization / parity oracle** | M1/M4 (Track B) | **auto-generating a trustworthy parity oracle** | ✅ done — generation + certification green on leven (34-case oracle, 20/20 determinism, mutation score 0.75, 1 real gap surfaced) |
| 02 | Ingestion / Phase 0 | M1 | fork intake, build baseline, `.agent-log/` + shadow metadata | ▶ next |
| 03 | Dependency graph extraction | M2 (Track C) | SCIP→stack-graphs→tree-sitter typed graph + per-edge confidence | pending |
| 04 | Slicing + DAG | M3 (Track D) | SCC→Leiden→topo, 5-gate slice bar, DAG assembly | pending |
| 05 | Slice orchestration | M4 (Track G) | Migration/Slice orchestrators, fan-out, merges, KV concurrency budget | pending |
| 06 | Integration/e2e + output PR | M5 | bottom-up integration nodes, assembled migrated PR + reports | pending |
| 07 | Control-plane + Blueprint packaging | M0/M6 | one-fork deploy (Workflow-service bootstrap), dashboard, cost controls | pending |

## Ticket stubs (01 is fully specced; 02–07 are scoped, to be detailed as they come up)

- **02 — Ingestion / Phase 0.** Intake a target fork, establish a runnable build baseline in the workspace checkout, and generate the shadow-metadata layer + slice-anchored `.agent-log/` scaffolding (spec §7.1, §9). Reuses `workspace.ts` checkout wiring. Feeds 01's source-behavior capture and 03's graph.
- **03 — Dependency graph extraction.** Tiered SCIP → tree-sitter stack-graphs → tree-sitter `.scm` tags; typed directional edges with `source`/`confidence` persisted in Postgres; expose as a first-class artifact/tool (spec §8.2, §12; Track C). Low-confidence/dynamic edges route to human gates.
- **04 — Slicing + DAG.** Deterministic backbone (Tarjan SCC → condensation → topo) + Leiden partition (directed) sized by the 5-gate slice bar; LLM judgment via graph-navigation tools; assemble the DAG with contract/integration/e2e test nodes (spec §7.2, §8.1; Track D).
- **05 — Slice orchestration.** Migration Orchestrator (pure function of Postgres DAG state) + Slice Orchestrator running R→P→I→V per slice; `Promise.allSettled` fan-out, reaper, per-migration/per-role KV concurrency budget, branch-per-slice + merge at join points (spec §6, §7.2, §9.4; Track G). Reuses render-agents durability.
- **06 — Integration/e2e + output.** Bottom-up integration test nodes as clusters complete; assemble the migrated branch/PR on the fork with per-slice reports + parity/coverage + residual decision log (spec §7.1 Phase 4–5, §10).
- **07 — Control-plane + Blueprint packaging.** `render.yaml` (web + Postgres + KV + crons) + control-plane bootstrap of the Workflow service (Blueprints can't yet manage Workflows — `DECISIONS.md` #1); dashboard for DAG/slice status + decision resolution; cost/observability hardening.

## Conventions (from epic-1)

Each ticket is a self-contained markdown doc: **Goal · Context · Scope (in/out) · Design · Deliverables · Acceptance · Risks/Open questions.** Sized to be handed to a coding agent (composer) with a reviewer gate, as in M0.5. Move to a `complete/` subfolder when landed.
