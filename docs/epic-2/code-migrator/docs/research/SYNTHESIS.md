# Research synthesis — cross-track conclusions

Rolls up tracks A–G + corpus into the decisions and spec changes that should feed Planning (spec §7.1 Phase 2) and DAG decomposition. Track docs hold the cited detail; this is the executive layer.

## Verdict

The spec's core thesis holds: **deterministic graph → sliced DAG → per-slice TDD-to-parity in isolated sandboxes, orchestrated durably**. But research surfaced **four load-bearing corrections** and one recurring theme.

**Recurring theme — "deterministic backbone, LLM residual."** Every track independently converged on the same shape: deterministic machinery does the heavy lifting (graph extraction, SCC/topo, discovery, curated dependency maps, exactly-once) and the LLM is scoped to *judgment and idiomatic edits*. This is now the project's central design principle and should be promoted in the spec.

## The four corrections (spec deltas)

1. **[A] Two spec claims are stale — fix §6.2/§6.3 and §11.2.**
   - opencode's `subagent_type` is **no longer hardcoded** (v1.17.19: free string, dynamically resolved). The MCP delegation shim (§6.3) must be **re-motivated by durability** (opencode subagents are ephemeral single-process, not 24h-safe), not by the obsolete limitation.
   - **Render Blueprints still cannot create Workflow services.** This breaks §11.2's headline "single `render.yaml`, one-click fork→deploy→run." Fix: bootstrap the Workflow service via CLI/API from the control plane, or ship a documented two-step deploy. Soften §11.1's "<1s" spin-up to "within seconds"; Workflows is beta, TS/Py only.

2. **[G] Render Workflows is per-task durable, not deterministic-replay.** No mid-task journal/memoization — a retried task re-runs from scratch. Render gives durable *plumbing* (isolated compute, queue, retries, timeouts, chaining, fan-out); **exactly-once, replay, signals, saga, and concurrency budgeting are ours to build on Postgres + Key Value.** The local `render-agents` repo already implements most of this (deterministic child IDs, event-log dedupe, `ctx.step` memoization, `FOR UPDATE SKIP LOCKED` single-flight queue, stranded-run reaper) — port it. Also: replace fan-out `Promise.all` with `Promise.allSettled` so a failed slice doesn't poison siblings (§7.2).

3. **[C] Graph extraction is under-specified — add SCIP.** The spec's tree-sitter+LSP framing (§8.2) overstates fidelity: tree-sitter alone is name-matching (unsafe for DAG edges, esp. dynamic langs); live LSP is heavy/uneven. Adopt a **3-tier best-fidelity pipeline: SCIP indexers (reuse Phase-0 build) → tree-sitter stack-graphs → tree-sitter `.scm` tags + heuristic fallback**, every edge stamped with provenance/confidence. Reuse Aider's PageRank repo-map algorithm verbatim, but **content-hash caching (not mtime)** and **deterministic tie-break rendering** (Aider issue #1874).

4. **[B] The parity oracle is harder than "capture source behavior" — reframe it.** It's a **differential-testing** problem (source vs. migrated on identical inputs), and **coverage is a near-worthless trust signal — anchor on mutation score.** The dominant failure mode is a *gamed/brittle* oracle, not low coverage (SWE-bench brittle tests reject ≥59% of correct fixes; agents can fake green). Oracle must be **source-owned, read-only to the Implementer, determinism-shimmed** (frozen clock, seeded RNG, VCR replay). Proposed gate: **G0 determinism + G2 ≥75% mutation score + G3 anti-gaming** are load-bearing.

## What the spec got right (validated)

- **[E] The "AI migration" pattern = deterministic engine + LLM edits + human gates** (Google's Kythe/AST + LLM; AWS Q rides OpenRewrite). Validates the whole approach; adds an explicit **deterministic-first, LLM-residual pass per slice** and a **codemod-vs-LLM routing rule**.
- **[E] Verification = SWE-bench's two-set gate** (PASS_TO_PASS = our characterization tests + FAIL_TO_PASS = target behavior), per-slice in a Docker sandbox. Formalize the Validator as this.
- **[D] Slicing = deterministic backbone (Tarjan SCC → condensation → topo) + Leiden/Louvain for size + min-cut for interface safety**, LLM judgment via graph-navigation *tools* (never serialization). Cycles: co-migrate small SCCs or break the weakest seam with an Extract-Interface shim (= the spec's transitional shim). Concrete **5-gate slice bar** proposed (size ≤~10 symbols/~400–600 LOC, ≤~5 cut edges, estimable, ≥1 attachable test, externally acyclic).
- **[F] Dependency substitution = curated map + fallback tiers + Anti-Corruption Layer** (not bare adapters), gated on characterization tests that pin named semantic-risk axes (float/NaN/collation drift). Proposed **DSDR** (Dependency Substitution Decision Record) subtype of §12 `Decision`, whose ACL interface *is* the slice's §8.4 migrated-upstream-signature, with `affected_slices` computed from the graph to DAG-gate downstream binding.

## Cross-track dependencies (important for sequencing)

- **B underpins D and F.** The 5-gate slice bar (D) and every substitution gate (F) assume auto-synthesized characterization/contract tests on cut edges — which is exactly Track B's hardest, least-proven capability. **B is the critical path.**
- **C underpins D.** Slicing quality is capped by graph edge fidelity; directional edges matter (community detection is undirected — must project directed modularity or boundaries are unsafe for the directional parity contract).
- **G underpins the whole orchestrator.** Exactly-once + failure isolation must exist before any real fan-out.
- **A gates everything empirical** — the harness must be proven before slices can run.

## Eval corpus (locked)

- **Smoke:** [leven](https://github.com/sindresorhus/leven) (JS→TS, ~60 LOC, strong tests, pure) — validates the pipeline end-to-end with existing tests as a ready oracle.
- **Stress #1:** [python-slugify](https://github.com/un33k/python-slugify) (Python→Go, ~350 LOC, strong tests) — dynamic→static + dependency substitution (`text-unidecode`, no clean Go equiv).
- **Stress #2:** [pygit](https://github.com/benhoyt/pygit) (Python→Go, ~500 LOC, **no tests**) — auto-characterization + determinism shims (FS, zlib, SHA-1, network). Run last.

These calibrate the unvalidated thresholds flagged across tracks (slice-size bar, mutation-score bar, deterministic-vs-LLM share — thinner deterministic coverage for Python→Go/Rust since OpenRewrite is JVM-centric).

## Recommended next step

Before Planning, run the **M0.5 harness spike** (Track A open item): boot opencode in a Workflow task, invoke a custom subagent via `subagent_type`, and prove LSP/compiler-feedback self-correction end-to-end on `leven` — using `agent-workflows-template` as the base and porting `render-agents`' idempotency/reaper stack (Track G). This validates A + G empirically and produces the skeleton the rest of the build sits on. Then proceed to Planning with the spec deltas above folded in.
