# Sprint 24 — NFR Hardening, Docs, Release/Publish

**Status:** DRAFT
**Wave:** 4 — DX, Operability & Ship
**Depends on:** all prior sprints
**Unblocks:** — (ships MVP)

---

## Goal

Bring the MVP to a releasable state: validate the non-functional targets, port the harness's hard-won edge-case test suite, write the public documentation, and publish the packages to npm with a reproducible release pipeline.

---

## Foundational decisions in play

- Non-functional requirements from [Operations → Non-functional requirements](../specs/04-operations.md#non-functional-requirements).
- [Porting principle 5](../specs/porting-map.md#4-porting-principles) — preserve the harness's edge-case coverage.

---

## Scope

**In:**
- **NFR validation** ([Operations NFR table](../specs/04-operations.md#non-functional-requirements)):
  - Node 20+, ESM-only, strict TS + declaration emit (verified across packages).
  - Agent load + validation < 500ms for 20 agents.
  - LLM-loop overhead < 10ms/turn (excluding model latency).
  - Event append latency < 5ms (append + projection update).
  - SSE delivery < 100ms append→client.
  - In-memory store provides equivalent loop semantics without Postgres (no durable resume across restarts — documented).
  - `@render-agents/sdk` < 100KB minified.
  - Zero external deps for observability (Postgres sufficient).
- **Edge-case test suite** (port the harness's "must not lose" cases — [Porting principle 5](../specs/porting-map.md#4-porting-principles)): concurrent thread turns, mid-loop crash + resume, OAuth token-refresh races, SSRF via DNS rebinding, budget overflow on the last turn. Plus the memory↔Postgres parity suite (Sprint 05) and the determinism/replay suite (Sprints 12/13).
- **Documentation:** README per package, a top-level getting-started (scaffold → run → deploy), the public API reference (generated from the Type Reference / TSDoc), and a "porting/architecture" overview linking the specs.
- **Release pipeline:** independent npm publish per `packages/*` (sdk/engine/store/gateway + `create-render-agent`), versioning/changesets, provenance, CI release workflow; bundle-size check in CI.
- **Examples polish:** the scaffolder's default project doubles as the canonical example; ensure it's documented and tested.

**Out:**
- New features — this sprint is hardening + ship only.
- The full operator-UI SPA (post-MVP); runtime-managed schedules (post-MVP); Python SDK, sandboxes ([Future Considerations](../specs/future-considerations.md)).

---

## Deliverables

- A CI suite asserting each NFR target (perf benches for load/append/SSE/loop-overhead; bundle-size gate; type/lint/test matrix on Node 20+).
- Ported edge-case tests covering the five harness scenarios + parity + determinism.
- Package READMEs + getting-started + generated API reference + architecture overview.
- Changesets/versioning + npm publish workflow (independent per package) with provenance.

---

## Porting source

- **H — Edge cases:** the scenarios called out in [Porting principle 5](../specs/porting-map.md#4-porting-principles) (`render-agent-harness` integration tests: `conversations.integration.test.ts`, `runs.integration.test.ts`, `connections.integration.test.ts`, etc.) — port the *scenarios* (not the harness's wiring) against the new contracts.
- **Both repos** — mine existing tests for coverage gaps; re-express against the SDK's testing utilities (`createTestRuntime`/`mockModel`).

---

## Implementation notes

1. **NFRs are CI gates, not aspirations:** encode each target as an automated check (perf benches may run on a labeled job to reduce flakiness). The < 100KB sdk bundle is a hard gate.
2. **Edge cases use the real loop:** port them against `createTestRuntime` (in-memory) and the Postgres parity harness so they run fast in CI but exercise real behavior.
3. **Docs derive from the spec:** the API reference is generated from the frozen types (Sprint 01) + TSDoc; the getting-started mirrors the scaffolder flow (Sprint 21).
4. **Independent publish:** each package versions/publishes on its own (the spec's build+publish model); the scaffolder pins compatible `@render-agents/*` ranges.
5. **Release reproducibility:** pin the package manager + Node; use changesets for coordinated multi-package releases; enable npm provenance.

---

## Exit criteria / acceptance

- Every NFR target has a passing automated check (load < 500ms/20 agents, append < 5ms, SSE < 100ms, loop overhead < 10ms/turn, sdk < 100KB, ESM-only, strict TS).
- The five harness edge-case scenarios pass against the new implementation; the memory↔Postgres parity and determinism/replay suites are green.
- `npm create render-agent` → build → run → deploy is documented and works end-to-end (getting-started validated).
- All five packages publish to npm (dry-run in CI, real publish on tag) with declarations + provenance; bundle-size gate passes.
- API reference + package READMEs + architecture overview are published.

---

## Risks / open questions

- **Perf-bench flakiness in CI:** micro-benchmarks (append/loop overhead) can be noisy on shared CI runners; consider thresholds with margin + a dedicated bench job, or track trends rather than hard-failing on small regressions.
- **Bundle-size gate vs dependencies:** keeping `@render-agents/sdk` < 100KB may constrain dependency choices (e.g. Zod, validators) — verify tree-shaking and consider moving heavy deps to `engine`.
- **Release coordination:** cross-package version compatibility (sdk↔engine↔store↔gateway) — use a coordinated changeset release and a compatibility test of the published artifacts (install-from-registry smoke test).
- **Live-provider tests in CI:** keep provider adapter tests on recorded fixtures; gate any live tests behind secrets + a manual job.
