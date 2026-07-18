**Author:** Jacob Prall

**Status:** Ideation (research-informed rev — 2026-07-17)

> **Revision note.** This spec folds in the findings from `docs/research/`
> (tracks A–G) and the resolutions in `docs/research/DECISIONS.md`. Two
> foundational decisions frame everything below: **`D-BASE`** — the system is
> built on the **`render-agents`** codebase (its durable orchestration,
> event-sourced log, and operator UI are our substrate); and **`D-NATIVE`** —
> coding roles run on **render-agents' native engine + the `workspace` tools**
> (shell/fs), getting compiler-feedback self-correction by running the target
> build/tests. This **supersedes the earlier `D-OPENCODE`** bet (opencode was
> validated in the M0.5 spike but abandoned as not worth the baggage — see
> `DECISIONS.md`). Validated end-to-end: the native `migrator` ported `leven`
> JS→TS with a green parity oracle (`docs/spikes/M0.5-harness-spike.md`).

### Summary

This project is an **agentic codebase migration system** that ports an existing repository to a target language while preserving observable behavior. 

It is packaged as a **fork-and-deploy template for Render.** The system provisions itself, runs the migration, and incorporates feedback as necessary.

### Approach & Rationale

We adapt the **Strangler Fig** philosophy to an **offline, fork-based** setting. Rather than routing production traffic between old and new, we establish ground truth via **characterization tests** on the source, then migrate one bounded **slice** at a time to behavioral parity inside isolated sandboxes, sequencing and parallelizing the work as a **DAG**.

Because old and new must coexist while a port is in flight, **transitional architecture is expected**: introduce minimal glue so both sides interoperate during a slice, then deprecate it once the slice lands. 

**Parity is the safety mechanism** that makes this incremental replacement safe.

### Goals & Non-Goals

#### Goals

- Migrate any repo to a target language with **behavioral parity**, verified by tests.
- **Never introduce net-new behavior.** Restructure and port; do not add features.
- Preserve existing imperfections **unless** target-language primitives allow a
simpler, more maintainable implementation of identical behavior.
- Maximize safe parallelism via an explicit dependency DAG.
- Be fully self-hostable as a **single `render.yaml` Blueprint** (fork → deploy → run).
- Produce a reviewable output: a migrated branch/PR plus structured reports.

#### Non-Goals (v1)

- In-production strangler routing (no live traffic cutover; migration is offline).
- Product redesign, feature additions, or architecture "improvements" beyond what
target-language primitives naturally afford.
- Guaranteeing 100% autonomous completion for arbitrarily large repos — humans
review at defined gates and resolve flagged decisions.

### 4. Core Concepts

Definitions used throughout; later sections reference these rather than
re-explaining them.

- **Slice** — a bounded migration unit with clear inputs/outputs and a verifiable
contract; the node of the migration DAG. If a slice can't be estimated or
verified, it is decomposed further.
- **Parity** — faithful reproduction of the source's *observable* behavior. A
slice is "done" only at parity; behavior-changing improvements are a separate,
banned-by-default backlog.
- **Characterization test (golden master)** — a test that captures what the code
*actually* does (not what it *should* do). The **parity oracle**.
- **Dependency graph** — the typed, directional graph of symbol relationships
(`imports`/`calls`/`extends`/`implements`); the machine artifact that drives
slicing and the DAG (§8).
- **Repo map** — the LLM-facing, token-budgeted projection of the *relevant*
graph neighborhood for a given agent (§8.3).
- **DAG** — the execution plan: slices as nodes, dependencies as edges; owned and
advanced by the Migration Orchestrator (§7.2).
- **Shadow metadata layer** — persisted annotations over every file/directory,
generated at ingestion, together with the agent-log reports below.
- **Agent-log** — the structured, persisted handoff reports agents write and read
(`.agent-log/`) instead of sharing memory (§9).
- **Transitional shim** — minimal, temporary glue that lets source and migrated
code coexist during a slice, deprecated once the slice lands.

### 5. Design Principles

1. **Ground truth before change.** Establish observable behavior with
characterization tests that capture what the code *actually* does, not what it
*should* do.
2. **Parity is the contract.** Each slice is "done" only when it reproduces the
source's observable behavior. Parity is verified **differentially** (source vs.
migrated on identical inputs) and the oracle's strength is judged by **mutation
score, not coverage** (coverage is a floor, not a trust signal). The oracle is
**source-owned and read-only to the Implementer** so parity can't be gamed
(§10).
3. **Slice small.** Bounded units with clear inputs/outputs; if a slice can't be
estimated or verified, decompose it further.
4. **Reduce complexity only via primitives.** Collapse accidental complexity when
the target language offers a first-class construct; otherwise mirror faithfully.
5. **Reversibility & durability.** Every step is checkpointed, retryable, and
individually reviewable.
6. **Handoff by artifact.** Agents communicate through structured, persisted
metadata and reports, not ephemeral memory (§9).
7. **Deterministic backbone, LLM residual.** Deterministic machinery does the
heavy lifting — graph extraction, SCC/topological ordering, discovery, curated
dependency maps, exactly-once orchestration — and the LLM is scoped to
*judgment and idiomatic edits*. Do not LLM what a codemod or a graph algorithm
can do deterministically (§7.2, §8.1). (Cross-language *transpiler*
scaffolding is deferred in v1 — see `DECISIONS.md` #3; the principle still
governs the deterministic-vs-LLM split within each slice.)

---

## How It Works

### 6. Architecture

#### Agent hierarchy

```
Migration Orchestrator            (root durable workflow; owns the DAG)
        │  triggers slices as dependencies clear; gates integration/e2e
        ▼
Slice Orchestrator (per slice)    (manages one slice's implementation lifecycle)
        │
        ├── Researcher   → gathers slice context from the shadow metadata layer
        ├── Planner      → produces the slice plan + test spec + effort estimate
        ├── Implementer  → writes tests, then code, in a sandbox until tests pass
        └── Validator    → runs characterization/integration checks; asserts parity
```

Subagents may spawn their own subagents in a structured flow (e.g. an Implementer fanning out across independent files within a slice).

#### 6.2 Harness: render-agents native engine

The system is built on the **`render-agents`** codebase (`D-BASE`), which
provides the whole substrate: an event-sourced Postgres log, replay-safe
workflows over Render Workflows, idempotency/reaper/fail-fast plumbing, HITL
approvals, an operator UI, a markdown agent authoring model, and a tool system.
Each node (Migration/Slice Orchestrator, Researcher, Planner, Implementer,
Validator) is a render-agents agent/workflow running on the **native engine**
(`DefaultRunner`) — a single runtime, first-class observability.

**Coding roles get compiler-feedback self-correction from tools, not a second
runtime (`D-NATIVE`).** The `workspace` tool set (`exec`, `read_file`,
`write_file`, `apply_patch`, `list_dir`, path-confined to the run's checkout)
lets a coding agent edit files and **run the target build/typecheck/tests via
`exec`, reading non-zero exits as normal feedback and iterating until green** —
which is exactly the self-correction loop. This was validated in M0.5: the
native `migrator` agent ported `leven` JS→TS, self-correcting `tsc` errors, to a
green parity oracle.

> **Superseded (`D-OPENCODE`).** An earlier revision made **opencode** a
> pluggable coding runtime. The M0.5 spike proved it *works* but showed it wasn't
> worth the baggage: the self-correction we valued is just "run the compiler via
> a shell tool and feed the error back" (render-agents already does this), while
> opencode added a separate binary, a blocking-prompt HTTP model that trips
> Node's 5-min fetch timeout on realistic runs, opaque errors, and a second
> runtime with reconstructed observability. Dropped. Its multi-language LSP-grade
> editing could be revisited far later if ever needed; the corpus (JS→TS,
> Python→Go) is well served by the shell-driven compiler-feedback loop.

> **Durability model (Track G).** Render Workflows is **per-task durable, not
> deterministic-replay**: a retried task re-runs from scratch (no mid-task
> journal). Render provides the durable *plumbing* (isolated compute, queue,
> retries, timeouts, chaining, fan-out); **exactly-once effects, step
> memoization, idempotency, saga/compensation, and concurrency budgeting are ours
> to build on Postgres + Key Value** — which render-agents already implements
> (deterministic child IDs, event-log dedupe, `ctx.step` memoization, `run_jobs`
> single-flight queue, stranded-run reaper). Reuse it.

Consequences:

- **Each Workflow task is a node** running a role-specific markdown agent (its
own model, prompt, tools, budget) on the native engine.
- **Workflows owns the DAG and is the single source of truth** — sequencing,
parallel fan-out (via `Promise.allSettled` for sibling isolation, §7.2),
retries, state, and long-running execution. The orchestrator is a **pure
function of persisted Postgres DAG state**.
- **In-session delegation** uses render-agents' native subagents/tools for
bounded work within a slice; cross-slice orchestration stays in Workflows (§6.3).

#### 6.3 Delegation via MCP tool

Expose the Workflow trigger as a small **MCP server** (portable across agents /
IDEs) and/or a **native render-agents tool** (lower-latency hot path) over one
shared endpoint. This makes delegation a plain tool call whose value is
**durable, distributed, 24h-safe delegation**. It maps directly onto
render-agents'/Render Workflows' `startTask` **handle-not-block** trigger
(`taskRunId` → `get_task_run`/`cancel_task_run`). Design constraints:

- **Return a handle, never block.** Runs can last up to 24h, so return
`{ run_id, status_url, queued }` immediately. Companion tools: `get_run_status`,
optional `await_run(timeout)` for short tasks, `cancel_run`.
- **Idempotent.** Require an idempotency key (e.g. `slice_id:attempt`) so a
double-call or retry can't spawn duplicate runs.
- **Role-scoped.** Grant the tool per agent via opencode permissions (e.g. Slice
Orchestrator may trigger Researcher/Planner/Implementer/Validator; Implementer
may not spawn a new Slice).
- **Correlated.** The tool and in-task SDK chaining share the *same* trigger logic
(Workflows stays authoritative, per §6.2). Persist `run_id ↔ DAG node` in
Postgres for dashboard correlation and surface concurrency-budget state.

```json
trigger_task({
  task_type: "researcher" | "planner" | "implementer" | "validator" | "slice_orchestrator",
  slice_id: string,
  args: { /* typed per task_type */ },
  idempotency_key: string,       // e.g. "slice-42:attempt-1"
  priority?: "normal" | "high"
}) -> { run_id, status_url, queued: boolean }
```

### 7. Execution Lifecycle

#### 7.1 Phases

**Phase 0 — Repo Preparation / Ingestion**

- Intake the target **fork** (the system operates on a fork, never the origin).
- Build the source; establish a runnable baseline.
- Establish **ground-truth behavior** via characterization tests.
- Generate a **shadow metadata layer**: annotate every file and directory, plus
slice-anchored **`.agent-log/`** reports for downstream handoff (see §9).

**Phase 1 — Research**

- Analyze the codebase; **extract the dependency graph** (§8).
- Map high-level behavioral concerns to code regions.
- Surface the most important **architecture & dependency questions** with
intelligent, defaulted recommendations for human sign-off.

**Phase 2 — Planning**

- Compose the dependency graph into a **topology of slices**; register an effort
estimate per slice.
- Produce a **DAG** that sequences work and parallelizes where safe.
- Decide **where integration and e2e tests are introduced** as slices land.

**Phase 3 — Implementation**

- The Migration Orchestrator executes the DAG. For each ready slice, a Slice
Orchestrator runs Research → Plan → Implement (TDD to parity) → Validate,
entirely inside sandboxes.

**Phase 4 — Integration & Validation**

- As a slice's dependencies complete and are ready for integration, run
integration tests, then e2e tests, gated by the orchestrator.

**Phase 5 — Output**

- Assemble the migrated code as a branch/PR on the fork, with per-slice reports,
parity/coverage results, and the residual decision log.

#### 7.2 The DAG

Nodes are slices; edges are dependencies derived from the source dependency graph.
The **DAG skeleton is derived deterministically** (§8.1): Tarjan **SCC →
condensation** collapses cycles into single nodes and yields a topological order
for free; **Leiden** community detection (directed projection) sizes slice
boundaries by minimizing the cut (= the slice's must-preserve interface). The
LLM's only role is judgment (validating/naming boundaries, effort estimates,
substitutions) via graph-navigation tools, never graph serialization.

The Migration Orchestrator (a **pure function of persisted Postgres DAG state**,
so a crash/re-drive recomputes identical decisions):

- Triggers all root (dependency-free) slices in parallel, subject to a
**concurrency budget** (per-migration and per-role semaphores in Key Value).
- Advances a downstream slice only once its upstream slices reach validated parity.
- Inserts **integration test nodes** when a cluster of interdependent slices is
complete (bottom-up, since we migrate dependencies-first), **contract-test nodes
on every cut edge**, and **sparse e2e nodes** near root/entrypoint clusters.
- Treats failures as isolated and retryable; a failed slice does not poison
siblings. Fan-out uses **`Promise.allSettled`** (not `Promise.all`) with each
slice's outcome recorded independently; a **stranded-run reaper** cron + fail-fast
dispatch guarantee no slice hangs `running` forever.
- Runs each slice on its own isolated branch and merges at DAG join points (§9.4).

**Slice acceptance bar (5 gates).** A candidate slice is accepted only if it is
*bounded in size* (~≤10 public symbols / ~400–600 LOC, fits an Implementer's
budget), *bounded in interface* (~≤5 cut edges), *estimable* (Planner confidence
≥ threshold), *verifiable* (≥1 attachable characterization test), and
*externally acyclic* (a single node in the condensation DAG). Failing any gate
triggers recursive descent on the Leiden hierarchy, or an SCC cycle-break
(Extract-Interface / Dependency-Inversion shim on the weakest edge). Thresholds
are starting defaults to calibrate on the eval corpus.

### 8. Dependency Graph & Repo Map

The dependency graph has **two distinct consumers**; conflating them is a primary
failure mode.

#### 8.1 Machine-consumed graph (drives the DAG)

Slicing, topological ordering, cycle detection, and safe parallelization run on a
**real graph structure** — persisted in Postgres, operated on with a graph
library (`networkx` / `graphlib`). **Never serialize the whole graph into a
prompt.** The LLM's role in Planning is *judgment* (proposing slice boundaries,
estimating effort, deciding dependency substitutions), not computing the
topological sort.

#### 8.2 Graph construction (Phase 0 ingestion)

A **tiered, best-fidelity-available pipeline** (Track C) — never trust
tree-sitter name-matching to drive DAG edges, since a wrong edge means a wrong
slice boundary:

- **Tier 1 — SCIP (preferred edge source).** After Phase 0 builds the source,
run the language's SCIP indexer (scip-python, scip-typescript, scip-java,
scip-clang, rust-analyzer, …) to load precise, typed, directional
`imports`/`calls`/`extends`/`implements` as a batch artifact. This reuses the
build we already do and avoids orchestrating live LSP. (SCIP was absent from the
original draft — it is now the primary edge source; LSIF is deprecated.)
- **Tier 2 — tree-sitter stack-graphs** where there is no SCIP indexer / no
resolvable build: scope-aware, cross-file *resolved* references without a
compiler — a big precision jump over name-matching for dynamic languages.
- **Tier 3 — tree-sitter `.scm` tags (always + fallback).** Aider-style queries
(40+ languages) for symbol/signature extraction and the repo-map ranking graph,
and as the last-resort heuristic edge source.
- **LSP is reserved for opencode's in-loop self-correction, not graph edges.**
- **Every edge carries `source` (`scip`/`stackgraph`/`treesitter-heuristic`) and
`confidence`;** low-confidence / unresolved dynamic-dispatch edges are routed to
a **human decision gate** rather than fabricated ("wrong context is worse than no
context").
- Edges are **typed and directional** (`imports`, `calls`, `extends`,
`implements`). Direction is essential — the parity contract is directional: you
must not break what *depends on* a slice.

#### 8.3 LLM-consumed representation (per agent)

Follows the **repo map pattern** (pioneered by Aider):

1. **Personalized PageRank**, seeded on the current slice's files, selects the
structurally relevant neighborhood (1–2 hops) — not the global map.
2. **Tiered, token-budgeted signatures**: top tier = full signatures + parent
scope; lower tiers = names only / one-line summary; fit via binary search to
the budget.
3. Guiding rule: **"wrong context is worse than no context."** Over-stuffing
irrelevant code increases hallucination — scope tightly.

#### 8.4 Migration-specific augmentations

- **Per-slice interface contracts** — the slice's *public interface* (what
depends on it) plus the signatures of its *direct dependencies*. Doubles as the
slice's "must-preserve inventory."
- **Behavioral anchors** — link each symbol to its characterization tests so the
Implementer sees the parity oracle alongside the structure.
- **Migrated upstream signatures** — once a dependency slice lands, feed its
*target-language* interface (not the source) so downstream slices bind to the
new contracts.

#### 8.5 Serialization

Render signature tiers as markdown/XML; render the compact **edge/adjacency**
section in a token-optimized tabular format (e.g. **TOON**) rather than JSON.
(Treat the encoder as swappable: TOON beats JSON decisively on edge lists but
only ~5–10% over plain CSV, so benchmark TOON vs. CSV vs. compact-JSON on real
adjacency lists with the production model before locking it — Track C.)
Keep prose minimal — favor high edge density (`A --calls--> B`) over paragraphs.
Produce the representation as a **first-class artifact** (a Workflow task or MCP
tool callable by both the orchestrator and the agents), not ad hoc per prompt.

### 9. Agent-Log Handoffs

Agents hand off work through structured, persisted reports rather than shared
memory (principle 6, §5). The design separates the **canonical record** from an
ergonomic **in-tree view**.

#### 9.1 Canonical vs. materialized

- **Source of truth:** **Postgres + object storage** — durable across container
teardown, queryable by the orchestrator and dashboard, immune to merge chaos.
- **Materialized view:** an in-repo `.agent-log/` tree that agents read/write with
normal file tools and that rides along in git. It is a projection of the
canonical store and can be regenerated or synced at any time.

> Note: `.agent-log/` (dotfile) supersedes the earlier `_agent-log/` naming from
`scratch.md`, so it stays naturally ignorable and out of the way.
> 

#### 9.2 Placement (slice-anchored, not per-directory)

- **Root `.agent-log/`** — orientation layer: slice registry, DAG state snapshot,
and cross-cutting/global decisions.
- **Per-slice `.agent-log/` at each slice root** (the common-ancestor directory a
slice owns) — *not* one in every directory. Per-dir-everywhere creates noise and
goes stale, since the migrated tree rarely maps 1:1 to the source tree.

#### 9.3 Naming & granularity

One append-only file per (slice × phase × run); unique names mean parallel
writers never collide, and the sequence reads as a handoff narrative:

```
.agent-log/<slice-id>/<phase>-<role>-<runid>-<datetime>.md
```

Each file is **YAML front-matter + prose body**:

```yaml
---
slice_id: slice-42
phase: implement            # research | plan | implement | validate
role: implementer
run_id: <workflow-run-id>
timestamp: 2026-07-16T12:00:00Z
upstream_refs: [research-*, plan-*]   # reports this build consumed
outputs: [<artifact/path or object-store keys>]
decisions: []
open_questions: []
status: complete            # complete | blocked | needs-review
parity_results: null        # populated by validator
---
```

#### 9.4 Isolation (worktree/branch per slice)

Each slice runs in its own container that clones the fork, so make that a **git
worktree/branch per slice** (`migration/slice-<id>`). `.agent-log/` entries commit
on that branch; the orchestrator merges slice branches at DAG join points (§7.2),
with integration/e2e on the assembled branch. Slice-namespaced filenames keep
merges conflict-free even when slices touch the same directory.

#### 9.5 Lifecycle

Logs are **working artifacts, not deliverables.** By default they are
gitignored/stripped from the migrated PR (clean target-language output), while the
complete set is preserved in object storage — and optionally on a
`migration-report/` branch — for auditability.

### 10. Testing Strategy

The parity oracle is the safety mechanism, so its discipline is spelled out
(Track B):

- **Characterization tests** (Phase 0): capture source behavior as the parity
oracle. The oracle is **differential** — compare source vs. migrated on identical
inputs — but the default persisted artifact is **frozen golden files** (captured
input corpus + scrubbed golden outputs), which survive source teardown and replay
against the migrated slice (`DECISIONS.md` #6). Golden values are captured from
the **source only** and are **read-only to the Implementer** (anti-gaming).
- **Determinism gate (mandatory before capture):** frozen wall+monotonic clock,
seeded RNG, VCR-style record/replay of I/O and network (`record_mode=none` in
CI), pinned container env, and an explicit **stable/unstable field
classification + scrubbers**. Slices that can't be made deterministic
(genuine concurrency / external mutable state) are **flagged for human review**,
not auto-gated green.
- **Oracle trust = mutation score, not coverage.** Coverage is a floor;
mutation testing (PIT/Stryker/mutmut) is the trust signal. **Parity gate:**
*G0 determinism* (green ≥N reruns, no live net) + *G2 mutation score* (triaged
survivors) + *G3 oracle independence/anti-gaming* are load-bearing; a coverage
floor, differential agreement on a held-out input set, and one-time human
approval of goldens are supporting gates. Exact thresholds are calibrated on the
eval corpus.
- **Slice TDD** (Phase 3): Implementer writes tests derived from the slice spec,
then implements until green. Validation is a **SWE-bench-style two-set gate**:
characterization tests as `PASS_TO_PASS` (parity: no regression) + slice-spec
tests as `FAIL_TO_PASS` (target behavior present), run in a clean per-slice
sandbox and graded via **structured reports** (no stdout scraping).
- **Integration tests** (Phase 4): triggered as interdependent slice clusters
complete (bottom-up); **contract tests live on the cut edges** (§7.2).
- **E2E tests** (Phase 4): validate the assembled migrated system end-to-end
(sparse, highest-value journeys only).
- Test-insertion points for integration/e2e are decided during **Planning** (§7.1)
and encoded as nodes in the DAG (§7.2).

---

## Platform & Delivery

### 11. Render Platform Mapping & Template

The entire system is expressed as Render primitives in one Blueprint.

#### 11.1 Primitive mapping

| Concern | Render primitive | Role |
| --- | --- | --- |
| Orchestration + agents | **Render Workflows** (TS/Python SDK), via **render-agents** | Every orchestrator and agent is a durable `task`. Chaining models the DAG; parallel runs fan out slices. Each run gets an isolated, on-demand container (spins up **within seconds**, scales to zero). Retries + timeouts up to 24h per task. **Per-task durable, not deterministic-replay** — exactly-once/idempotency/memoization built on Postgres+KV (render-agents provides this). Concurrency is bounded by a **workspace-wide max-concurrent-runs cap** (paid, raisable) plus our KV budget. Beta; TS/Python only. |
| Agent harness | **render-agents** native engine (`DefaultRunner`) for all roles | One runtime; role-specific markdown agents. Coding roles get compiler-feedback self-correction from the `workspace` tools (`exec`/`read_file`/`write_file`/`apply_patch`) — run the target build/tests, feed non-zero exits back, iterate (§6.2). opencode dropped (`D-NATIVE`). |
| Sandbox build/test | **Workflow task container** (+ Preview Environments for full-app e2e) | Each Implementer/Validator run is its own ephemeral container running opencode: clone fork, write code, run tests, discard. Full-stack e2e can use ephemeral **Preview Environments**. |
| Control plane + dashboard | **Web service** | Kick off migrations, view DAG/slice status, resolve flagged decisions, download output. |
| State & metadata | **Postgres** | DAG, slice status, effort estimates, dependency graph, decision log, run history. |
| Queue / coordination / cache | **Key Value** (Redis-compatible) | Coordination, rate-limit budgeting, transient locks. |
| Artifacts & agent logs | **Object storage** (when GA) / disk / Postgres | Canonical store for the shadow metadata layer, `.agent-log/` handoff reports (§9), and test artifacts. |
| Self-provisioning | **Render MCP + CLI + API** | Agents provision/manage preview envs and resources as needed. |
| Packaging | **Blueprint (`render.yaml`)** + **Deploy to Render** button | One-click fork-and-deploy. |

#### 11.2 Fork-and-deploy template

> **Caveat (Track A, `DECISIONS.md` #1): Render Blueprints cannot yet create or
> manage Workflow services.** So true "single `render.yaml`, one-click
> fork→deploy→run" is not achievable today. The accepted v1 flow is: the
> Blueprint provisions the control-plane web service, Postgres, Key Value, and
> crons; the user **forks and registers the Workflow service / tasks**
> themselves (Dashboard or Render CLI/API). Track Render's roadmap to reclaim
> one-click when Blueprint-managed Workflows ship.

1. Repo ships a root **`render.yaml`** declaring: control-plane web service,
Postgres, Key Value, crons, and an environment group for secrets. **The Workflow
service is registered separately** (per the caveat above) — optionally
bootstrapped by the control plane via the Render CLI/API on first run.
2. README carries a **Deploy to Render** button (with `autoDeployTrigger: off`
recommended for template repos) plus a documented "register Workflow tasks" step.
3. On first deploy, Render provisions all resources and prompts (via `sync: false`
env vars) for required secrets.

**Required configuration (inputs)**

- **Target repository** (the fork to migrate).
- **Target language** (and optionally framework/runtime).
- **Key decisions**: e.g. dependency substitutions, module boundaries, allowed
complexity reductions, concurrency budget, review-gate strictness.
- **Secrets**: LLM provider key(s), `RENDER_API_KEY`, Git provider token.

### 12. Data Model

- **Migration** — id, source fork, target language, decisions, status, phase.
- **DependencyGraph** — nodes (files/symbols), **typed directional edges**
(`imports`/`calls`/`extends`/`implements`) each carrying **`source`
(`scip`/`stackgraph`/`treesitter-heuristic`) and `confidence`** (§8.2),
PageRank scores.
- **SliceInterface** — per-slice public contract + direct-dependency signatures
(the "must-preserve inventory"), with links to characterization tests.
- **Slice** — id, scope, dependencies, effort estimate, status, sandbox refs.
- **Behavior/CharacterizationTest** — slice ref, inputs, recorded outputs.
- **AgentRun** — task type, slice ref, inputs, outputs, retries, logs, artifacts.
- **TaskRun** — `run_id`, triggering agent/role, task type, slice ref,
idempotency key, status, DAG-node correlation (maps triggered Workflow runs to
slices for the dashboard).
- **Decision** — question, recommendation, resolution, resolver, timestamp.
- **DependencySubstitution (DSDR)** — a subtype of `Decision` for cross-language
library substitution (§8.4, Track F): source dependency + used symbols, chosen
strategy (native / native-behind-ACL / reimplement-subset / interop-shim), the
**ACL interface** (which *is* the owning slice's public contract / migrated
upstream signature), `semantic_risk_axes` + linked parity tests, and
`affected_slices` (blast radius from the graph) that DAG-gate downstream binding
until `accepted`. Superseding re-opens `affected_slices` for re-migration behind
a blocking gate (`DECISIONS.md` #8).
- **Report** — the slice-anchored `.agent-log/` handoff documents (§9);
canonical copy in Postgres/object storage, materialized in-tree.

---

## Part IV — Planning

### 13. Open Questions & Risks

> Many original risks now have research-backed approaches (see `docs/research/`
> + `DECISIONS.md`); items below are annotated **[approach set]** or **[open]**.

- **Dependency-graph extraction** — **[approach set]** tiered SCIP →
stack-graphs → tree-sitter with per-edge confidence; low-confidence/dynamic
edges routed to human gates (§8.2). *Residual:* pure-runtime dispatch
(monkey-patching, reflection) still can't be statically resolved.
- **Repo-map artifact cost/freshness** — **[approach set]** content-hash tag
cache (not mtime) + map keyed by `(slice_id, seed, budget, graph_version)`,
invalidated on upstream-slice landing; deterministic rendering for cache
stability (Track C). *Residual:* validate cost at monorepo scale.
- **Characterization coverage** — **[approach set]** determinism gate +
mutation-score trust bar + frozen goldens + differential harness (§10, Track B).
*Residual:* from-scratch oracle yield on weakly-tested repos; policy for
legitimately nondeterministic slices; gate cost/tiering.
- **Slice boundary quality** — **[approach set]** deterministic SCC→Leiden→topo
backbone + 5-gate acceptance bar (§7.2, Track D). *Residual:* directed-partition
tuning; threshold calibration on corpus.
- **Cross-language dependency substitution** — **[approach set]** catalog-seeded
proposal → ACL → parity-tested DSDR (§12, Track F). *Residual:* seed-catalog
freshness; blast-radius query cost.
- **Cost/concurrency budgeting** — **[open/approach set]** KV semaphores
(per-migration + per-role) + workspace cap; needs a validated cost model for
large fan-outs (best-of-N, mutation testing).
- **Human-in-the-loop gates** — **[resolved: configurable]** defaults block on
substitutions, large-SCC cycle-breaks, and parity-gate failures (`DECISIONS.md`
#2).
- **Harness validation** — **[open]** `D-OPENCODE` (opencode as coding runtime +
event bridge into render-agents) is pending the **M0.5 spike**
(`docs/spikes/M0.5-harness-spike.md`).
- **Object storage GA timing** for artifact persistence (interim: Postgres/disk).

### 14. Milestones

- **M0 — Template skeleton:** built on **render-agents**; `render.yaml`
(control plane, Postgres/Key Value, crons) + Deploy-to-Render button, Workflow
service registered separately (§11.2 caveat); end-to-end "hello workflow".
- **M0.5 — Harness spike (DONE):** native `migrator` agent (render-agents engine
+ `workspace` tools) ported `leven` JS→TS end-to-end via the `leven-migrate`
workflow, self-correcting `tsc` errors, to a **green parity oracle** (`tsc`
clean + `ava` 3/3). Established `D-NATIVE` (opencode abandoned)
(`docs/spikes/M0.5-harness-spike.md`, §6.2).
- **M1 — Ingestion (Phase 0):** fork intake, build baseline, shadow metadata
layer + `.agent-log/` generation (§9).
- **M2 — Research + graph (Phase 1):** tree-sitter + LSP dependency extraction,
typed graph in Postgres, repo-map artifact generation, behavioral mapping,
decision surfacing (§8).
- **M3 — Planning + DAG (Phase 2):** slice topology, effort estimates,
parallelizable DAG, test-insertion planning (§7.2).
- **M4 — Implementation loop (Phase 3):** Slice Orchestrator running
Research→Plan→Implement→Validate in sandboxes to slice parity.
- **M5 — Integration/e2e + output (Phases 4–5):** gated integration/e2e,
assembled migrated PR + reports.
- **M6 — Hardening:** cost controls, retries/observability, multi-language analyzers.