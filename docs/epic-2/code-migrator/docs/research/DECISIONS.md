# Decisions log

Running record of resolved design decisions, feeding Planning and the spec update. Sourced from the research tracks (A–G, corpus) and reviewed with Jacob. Immutable entries; supersede rather than edit.

## Foundational direction (2026-07-17)

- **D-BASE — Build directly on `render-agents`.** code-migrator is built *on* the `render-agents` codebase (own the source, no external dependency; it's pre-release and not deployed, so freely mutable). render-agents is the orchestration + durability + ops + observability substrate; we add the migration-specific layers (graph, slicing, parity, DAG) on top. Resolves the license question (we absorb/co-develop rather than depend).
- **D-OPENCODE — ~~opencode is a pluggable *coding* runtime inside render-agents~~. SUPERSEDED by `D-NATIVE` (2026-07-17).** The M0.5 spike proved opencode *works* (headless port of `leven` to `run.completed` with real `tsc` self-correction, events mapped into the `RunEvent` stream), but it also showed the value didn't justify the baggage — see `D-NATIVE`.
- **D-NATIVE — coding roles run on render-agents' native engine + the `workspace` tools (opencode abandoned).** Decision (2026-07-17): drop opencode entirely. Rationale from the spike:
  - The self-correction we cared about is just **"run the compiler/tests via a shell tool and feed non-zero exits back"** — which render-agents already does. Its `workspace` tool ships `exec`/`read_file`/`write_file`/`apply_patch`/`list_dir`, and the `implementer`/`migrator` agents run that loop on the native `DefaultRunner`. opencode's LSP wasn't even the mechanism (the winning run self-corrected via `tsc` in bash).
  - opencode's baggage: a separate CLI binary to install/manage; a **blocking-prompt HTTP model** that trips Node's undici 5-min headers timeout on realistic (>5 min) runs; opaque errors (generic `500` hid `ProviderModelNotFoundError`); a **second agent runtime** with observability *reconstructed* by mapping SSE events instead of first-class.
  - **Validated live (2026-07-17):** the native `migrator` agent ported `sindresorhus/leven` JS→TS end-to-end via the gateway `leven-migrate` workflow — workflow `status: completed`, and the parity oracle **green on all four gates** (`index.ts` artifact, deps, `tsc --noEmit` exit 0, behavior `npx ava` 3/3). Branch `spike/m0.5-opencode-runtime`; typecheck + parity unit tests green.
  - **Parity-oracle correction:** parity measures *observable behavior* (the characterization tests, `npx ava`), **not** the repo's `npm test` (which for leven bundles `xo` lint — not behavior, and broken under Node 24). Deferred (not needed now): opencode's multi-language LSP-grade editing could be revisited far later; for the corpus (JS→TS, Python→Go) the shell-driven compiler-feedback loop suffices.

## Resolved decisions (2026-07-17)

| # | Decision | Resolution |
| --- | --- | --- |
| 1 | One-click deploy / Blueprint-can't-manage-Workflows gap | **Accepted as-is.** Users fork and register Workflow tasks themselves; not a true one-click. Blueprint provisions web+Postgres+KV+crons; Workflow service registered manually/CLI. |
| 2 | Human-gate strictness (block vs proceed-with-default) | **Configurable.** Ship sensible defaults (block on: dependency substitutions, large-SCC cycle-breaks, slices failing the parity gate) but make strictness configurable. |
| 3 | Cross-language transpiler scaffolding in v1 | **No — LLM-only for now.** Defer c2rust/py2many transpiler-as-scaffold. |
| 4 | Do all roles run opencode, or split? | **Split.** opencode for coding roles; render-agents engine for non-coding roles (see D-OPENCODE). |
| 5 | Semantic-diff / LLM-review gate on top of tests? | **No.** Tests + human PR review only for v1. |
| 6 | Differential oracle: live source service vs frozen goldens | **Frozen golden files** for now. |
| 7 | Fallback when a slice can't clear the parity bar | **Decompose first, escalate to human after N tries.** |
| 8 | Superseded-substitution path | **Reuse `graph_version`-bump invalidation** (Track C): a superseding DSDR flips `affected_slices` → `needs-remigration` and re-enqueues them as normal DAG nodes bound to the new ACL interface, gated by the same characterization tests. Blocking human gate shows blast radius + cost first. No special machinery; ADR immutability preserved, only code re-migrates. |
| 9 | SCIP as Tier-1 edge source (tree-sitter stack-graphs → `.scm` fallback) | **Yes.** Update §8.2. |
| 10 | Drop live-LSP graph harvesting in favor of SCIP+stack-graphs | **Yes.** LSP retained only for opencode's in-loop self-correction. |
| 11 | Per-edge `source`/`confidence` in data model; low-confidence → human gate | **Yes.** |
| 12 | Leiden partitioning with directed modularity projection | **Yes.** |
| 13 | Parity gate structure (G0 determinism + G2 mutation + G3 anti-gaming load-bearing) | **Yes.** Oracle source-owned, read-only to Implementer, structured-report grading. Thresholds calibrated on corpus. |
| 14 | Delegation as native opencode tool (hot path) + MCP server (portable) | **Yes.** Re-motivated around durability, not the (now-false) `subagent_type` limitation. |
| 15 | KV vs Postgres split (KV hot budgeting/rate-limit/locks; Postgres durable record) | **Yes.** Per-migration + per-role semaphores in KV. |
| 16 | Orchestrator = pure fn of Postgres DAG state; `Promise.allSettled` fan-out; reaper + fail-fast from day one | **Yes.** Port render-agents' durability layer. |
| 17 | FFI/interop shims transitional-only; DSDR as subtype of §12 Decision | **Yes.** Never shipped in clean target output. |
| 18 | Root-selection heuristic: low-risk isolated leaf slices first | **Yes.** |
| 19 | Tag slices `deterministic\|hybrid\|llm` at planning; embed codemod engines as tools | **Yes.** (Deterministic coverage thin for Python→Go/Rust.) |
| 20 | Eval corpus trio: `leven`, `python-slugify`, `pygit` | **Confirmed.** Fallback: swap `pygit`→`dbader/schedule` if network-push is too awkward to characterize early. |

## Deferred / empirical (calibrate on corpus, no decision now)

Parity thresholds (80% branch / 75% mutation); slice-size numbers (~10 symbols / 400–600 LOC / ≤5 cut edges); TOON vs CSV vs JSON edge encoder benchmark; best-of-N ranking cost vs concurrency budget; opencode cold-boot cost per container; cancellation-cascade depth for task chains; repo-map cost at monorepo scale; seed-catalog freshness + Python→Go equivalence catalog; semantic-risk-axis taxonomy per dependency category.

## Ticket 01 — Characterization / parity oracle (2026-07-17): validated

The biggest-risk capability (Track B) is de-risked. On branch `epic-2/01-characterization`: a pure `oracle.ts` certification module (determinism check + seeded mutation battery + gates; 13 unit tests), a native `characterizer` agent, and a `characterize` workflow (clone → generate → source-pristine guard → certify). **Live on `leven`:** the agent independently generated a 34-case oracle (ignoring leven's own tests), which passed **G0 determinism (20/20)** and **G2 mutation score (0.75)** → `certification.ok: true`. Notably mutation testing **surfaced a real oracle gap** (1 of 4 mutants survived) that coverage would have missed — confirming the Track B stance (mutation score, not coverage, is the trust signal). Follow-ups: mutation-feedback loop to strengthen weak oracles; full StrykerJS; from-scratch on a no-tests repo (`pygit`); wire into `leven-migrate`'s parity gate. Details: `docs/spikes/`… → now `sprints/00-mvp/01-*`.

## Next step

**M0.5 harness spike** validates D-BASE + D-OPENCODE + Tracks A/G at once: scaffold on render-agents, boot opencode headless inside one `agent.task()` on the `leven` repo, invoke a custom subagent via `subagent_type`, prove compiler-feedback self-correction, and confirm opencode SSE events project into render-agents' event log.
