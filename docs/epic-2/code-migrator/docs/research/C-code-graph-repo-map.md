# Track C — Code graph & repo map

> De-risks: spec §8 (dependency graph & repo map), §13 (extraction edge cases, repo-map cost/freshness).

## Question

1. Is the **tree-sitter + LSP hybrid** (§8.2) reliable for typed, directional edges (`imports`/`calls`/`extends`/`implements`) across languages — especially dynamic languages and languages with weak/no LSP?
2. Is **Sourcegraph SCIP/LSIF** a stronger or complementary alternative for a precise, language-agnostic index?
3. Does the **personalized-PageRank repo map** (§8.3, Aider pattern) scale, and what's its per-agent cost/freshness story (caching, incremental updates as slices land)?
4. Is **TOON** (§8.5) actually worth it vs. alternatives for compact edge serialization?

## Why it's load-bearing

The machine graph drives slicing and the DAG (§8.1); the repo map is every agent's context window. "Wrong context is worse than no context" (§8.3) — bad graph fidelity or bloated maps directly cause hallucination and bad slice boundaries.

## Sources to review

- **Aider** repo map: Paul Gauthier's blog posts on repo map + tree-sitter `.scm` queries + graph ranking; the `.scm` query set (40+ langs).
- **Sourcegraph SCIP** (and legacy LSIF) — precise cross-repo code intelligence index.
- tree-sitter query docs; LSP `textDocument/references`, `callHierarchy`, `documentSymbol`.
- Graph libs: `networkx`, Python `graphlib` (topological sort, cycle detection).
- **TOON** format spec/repo — verify it exists, tradeoffs vs. CSV/compact-JSON for adjacency.

## Findings

### 1. tree-sitter + LSP hybrid for typed, directional edges

- **tree-sitter alone is a tokenizer/CST, not a resolver.** It parses each file into a Concrete Syntax Tree with no scope, type, or cross-file symbol resolution. It reliably gives you *definitions and references within a file* (function/class/method/type names, import statements, call sites) but **cannot tell you which file/symbol a reference resolves to.** The tree-sitter maintainers say cross-file resolution is explicitly "out of scope" and point users to `tree-sitter-graph` / `stack-graphs` ([tree-sitter discussion #2520](https://github.com/tree-sitter/tree-sitter/discussions/2520)). A deeper critique: tree-sitter's CST erases the structure needed for real program analysis ([cubix: "Why Tree-Sitter Is Inadequate for Program Analysis"](https://www.cubix-framework.com/tree-sitter-limitations.html)).
- **Consequence for our edge types:** tree-sitter gives good `imports` (from import statements) and good *local* `calls`/`extends`/`implements` **names**, but turning `foo.bar()` into a directional edge to the *right* `MyModule.MyClass.bar` requires a semantic layer. Aider's own repo-map only ever does **name-matching** across files (definition name == reference name), which it openly treats as a heuristic — good enough for ranking, **not** precise enough to drive a dependency DAG where a wrong edge means a wrong slice boundary.
- **Dynamic languages are the worst case.** Monkey-patching, runtime imports, duck typing, reflection, and dynamic dispatch (Python/Ruby/JS) can't be resolved statically without type inference or execution; name-matching over-connects (same method name on unrelated classes) and under-connects (indirection). This is the spec's §13 risk, and it is real.
- **Three fidelity tiers** (from [py-stack-graphs](https://pypi.org/project/py-stack-graphs/)):
  - *tree-sitter*: `foo.bar()` → "calls foo.bar" (unresolved string).
  - *stack-graphs*: `foo.bar()` → "calls `MyModule.MyClass.bar`" (resolved via imports/scopes, no build needed).
  - *LSP/SCIP*: `foo.bar()` → "calls `MyModule.MyClass.bar`, returns int" (fully typed, needs a configured/buildable project).
- **LSP is real but operationally heavier than §8.2 implies.** LSP servers are stateful, interactive, per-language processes designed for an editor session, not batch indexing. `callHierarchy` in particular is **optional in the protocol and unevenly implemented** across servers; quality of `textDocument/references` depends on the project being resolvable (deps installed, config present). "opencode already spawns LSP servers, so harvest this during ingestion" is plausible but non-trivial to do reliably headless across a polyglot repo, and reference queries per symbol are O(symbols) round-trips.

### 2. Sourcegraph SCIP / LSIF

- **SCIP is the current standard; LSIF is dead.** Sourcegraph fully deprecated and removed LSIF; [LSIF.dev is archived](https://lsif.dev/) and redirects to SCIP. SCIP replaces LSIF's opaque integer IDs with human-readable symbols, uses a [Protobuf schema](https://github.com/sourcegraph/scip), yields indexes often ~80% smaller, and limits the "blast radius" of indexer bugs ([SCIP DESIGN.md](https://github.com/sourcegraph/scip/blob/main/docs/DESIGN.md), [scip-code.org](https://scip-code.org/)).
- **SCIP is complementary, not a competitor, to tree-sitter — and a *better fit than live LSP* for our batch ingestion.** It's a precise, language-agnostic **on-disk index** ("transmission format," per DESIGN.md) with mature per-language indexers: [scip-python](https://github.com/sourcegraph/scip-python) (built on Pyright), [scip-typescript](https://github.com/sourcegraph/scip-typescript), [scip-java](https://github.com/sourcegraph/scip-java) (Java/Scala/Kotlin), [scip-clang](https://github.com/sourcegraph/scip-clang), [scip-ruby](https://github.com/sourcegraph/scip-ruby), [scip-dotnet](https://github.com/sourcegraph/scip-dotnet), rust-analyzer emits SCIP natively, etc.
- **Key caveat: SCIP indexers generally need a *buildable/resolvable* project** (scip-python runs Pyright; scip-typescript wants a tsconfig; scip-java needs Maven/Gradle/sbt). This is a strong match for our pipeline because **spec §7.1 Phase 0 already "builds the source; establishes a runnable baseline"** — so the prerequisite SCIP wants is a step we already do. Where a build isn't available, SCIP indexers degrade or fail, and we fall back down the tier ladder.
- **Net:** SCIP gives precise, directional, typed `imports`/`calls`/`extends`/`implements` as a batch artifact without us orchestrating live LSP sessions. The spec omits SCIP entirely; that's a gap.

### 3. Personalized-PageRank repo map (Aider pattern)

- **How it works** ([Aider repo-map writeup, Paul Gauthier, 2023-10-22](https://aider.chat/2023/10/22/repomap.html); [docs](https://aider.chat/docs/repomap.html); [repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)):
  1. tree-sitter extracts **definitions and references** per file via `.scm` "tags" queries (Aider ships query sets for ~40+ languages via `tree-sitter-language-pack`; the queries are Apache-2.0).
  2. Build a `networkx.MultiDiGraph`: **nodes = files**, **edges from referencing file → defining file**, weighted by reference (identifier) importance and multiplicity.
  3. Run **personalized PageRank** with the personalization vector seeded on the current chat files / mentioned identifiers, then distribute each file's rank back across the specific definitions it exports.
  4. Select top-ranked definitions to fit a token budget (default `--map-tokens` 1k) via **binary search**, rendering elided, scope-aware signatures (parent scope headers + `⋮` elision, via [grep-ast](https://github.com/paul-gauthier/grep-ast)).
- **This maps cleanly onto us:** our seed is "the current slice's files" (§8.3), which is *stable per slice* — more cacheable than Aider's chat state that changes every turn.
- **Cost / freshness characteristics:**
  - **Two cache layers.** (a) Per-file **tags cache keyed by `os.path.getmtime`** in SQLite — a file is only re-parsed when its mtime changes ([repomap.py `get_tags`](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)). (b) The **rendered map is cached keyed by chat/seed state**; `--map-refresh {auto,files,manual,always}` controls recompute (`auto` skips recompute when the last build took <1s) ([Aider v0.51.0](https://github.com/Aider-AI/aider/releases/tag/v0.51.0)).
  - **PageRank itself is cheap**; the cost is tree-sitter parsing on cold cache and, on huge monorepos, map assembly. Monorepos (~4k+ files) were historically slow ([issue #592](https://github.com/paul-gauthier/aider/issues/592)), later given a ~2× speedup + component caching.
  - **Determinism gotcha (load-bearing for our caching):** when the map is summarized to fit budget, **ties in PageRank score produced non-deterministic file/method selection**, silently busting prompt caches ([issue #1874](https://github.com/Aider-AI/aider/issues/1874)); the fix was a deterministic tie-break sort. We must sort ties deterministically so identical inputs yield byte-identical maps.
  - Provider-side prompt caching (`--cache-prompts`) caches the system prompt + repo map across requests to cut latency/cost.

### 4. TOON serialization (§8.5)

- **It exists and is recent.** TOON (Token-Oriented Object Notation), by Johann Schopplich, released ~Oct 2025 ([toon-format/toon](https://github.com/toon-format/toon/); [SPEC.md](https://github.com/toon-format/spec/blob/main/SPEC.md)). It's a lossless encoding of the JSON data model: YAML-style indentation for nesting + **CSV-style tabular rows for uniform arrays of objects**, declaring the array length `[N]` and `{field,list}` header once.
- **Its sweet spot is exactly our edge/adjacency lists** — uniform arrays of objects (`{src, dst, type, weight}`). Reported ~30–60% fewer tokens than JSON on uniform data, with equal-or-better extraction accuracy across model families (self-reported: 73.9% vs JSON 69.7% on a 209-question suite).
- **But vs. CSV the win is marginal.** The spec's own maintainers note **CSV is smaller than TOON for pure flat tables; TOON adds ~5–10% overhead** to buy structure (length guard, field header, delimiter scoping) ([toon README](https://github.com/toon-format/toon/), [SPEC.md](https://github.com/toon-format/spec/blob/main/SPEC.md)). There's also a "prompt tax" for teaching a novel format, and it's a young ecosystem. So: **TOON beats JSON decisively for edge lists, but only narrowly beats CSV** — and an edge list is essentially a flat table.

### 5. Graph libraries (machine graph, §8.1)

- **`graphlib` (stdlib) — execution scheduling.** [`graphlib.TopologicalSorter`](https://docs.python.org/3/library/graphlib.html) does topo sort, raises `CycleError` (with the offending node cycle) on `prepare()`, and — critically for our DAG — exposes **`get_ready()` / `done()` for parallel scheduling**: it hands you exactly the set of nodes whose dependencies are satisfied, which is precisely the Migration Orchestrator's "trigger slices as dependencies clear" loop (§7.2). No dependency, always available.
- **`networkx` — analysis.** Needed for what `graphlib` can't do: **`pagerank(personalization=...)`** for the repo map, **`strongly_connected_components`** to *detect and collapse dependency cycles* into single slices (condensation) before topo-sorting, plus `transitive_closure`/`reverse` for impact analysis ([networkx cycle/connectivity guide](https://medium.com/@jainsnehasj6/networkx-for-python-a-practical-guide-to-cycle-detection-and-connectivity-algorithms-f6025c73915d); note graphlib deliberately does **not** expose SCCs or node querying — [cpython #129847](https://github.com/python/cpython/issues/129847)).
- These are complementary: **networkx to build/analyze/condense the graph, graphlib to drive execution.**

## Recommendation

**Extraction stack — a tiered, best-available-fidelity pipeline** (never rely on tree-sitter name-matching for DAG edges):

1. **Tier 1 — SCIP as the precise edge source (preferred).** During Phase 0, after the source builds, run the language's SCIP indexer (scip-python/-typescript/-java/-clang/-ruby/rust-analyzer, etc.) and load the SCIP index as the authoritative source of typed, directional `imports`/`calls`/`extends`/`implements`. This reuses the Phase 0 build we already do and avoids orchestrating live LSP.
2. **Tier 2 — stack-graphs where no SCIP indexer / no build.** For dynamic languages without a resolvable build, use tree-sitter **stack-graphs** to get scope-aware, cross-file *resolved* references without a compiler — a big precision jump over name-matching for Python/JS/TS.
3. **Tier 3 — tree-sitter `.scm` tags (always, and as fallback).** Use Aider-style tree-sitter queries everywhere for symbol/signature extraction and for the repo-map ranking graph, and as the last-resort (heuristic, name-matched) edge source for languages with no better option. **Tag every edge with its provenance/confidence** (`scip` | `stackgraph` | `treesitter-heuristic`) and persist it in Postgres, so slicing (Track D) can distrust low-confidence edges and route them to human decision gates. Optionally harvest opencode's already-running LSP `references`/`callHierarchy` opportunistically to confirm high-stakes edges, but don't make the graph depend on live LSP.

**Repo map:** adopt Aider's algorithm directly (networkx personalized PageRank over a file/symbol graph → per-tier signatures → binary-search to budget), seeded on the **slice's files** rather than chat state. Reuse Aider's Apache-2.0 `.scm` query set and `grep-ast` rendering rather than reimplementing. Add our §8.4 augmentations (interface contracts, behavioral anchors, migrated-upstream signatures) as extra seed nodes / pinned tiers.

**Caching / invalidation (repo-map artifact):**

- **Per-file tag cache keyed by content hash (preferred) or mtime.** Aider uses mtime; in our container/worktree world mtime is unreliable across clones and checkouts, so key on a **git blob SHA / content hash** instead. Cache in Postgres (canonical) with an in-container SQLite/disk mirror.
- **Rendered map keyed by `(slice_id, seed set, budget, upstream-signature version)`.** Because a slice's seed is stable, the map is fully cacheable per slice and only invalidates when (a) a seed file's hash changes, or (b) an **upstream slice lands** and its migrated target-language signatures replace the source ones (§8.4). Model landings as a monotonically increasing `graph_version`; bump it on merge at DAG join points and let it invalidate downstream maps — this is the "incremental update as slices land" mechanism.
- **Enforce deterministic rendering** (stable tie-break sort on equal PageRank, sorted key order) so identical inputs produce byte-identical maps — required for both our cache and provider-side prompt caching (per Aider issue #1874).

**Serialization (§8.5):** render signature tiers as markdown/XML (as speced). For the edge/adjacency block, **TOON is a reasonable default over JSON**, but treat it as an easily-swappable encoder and **benchmark TOON vs. CSV vs. compact-JSON on real edge lists with the target model** before committing — the edge list is a flat table where CSV is within ~5–10% of TOON at zero prompt-tax. Ship the graph as a first-class artifact (Workflow task / MCP tool) regardless of encoding.

**Machine graph:** `networkx` for construction, PageRank, and **SCC condensation (collapse cycles into single slices) before ordering**; `graphlib.TopologicalSorter` with `get_ready()`/`done()` to drive the orchestrator's parallel dependency-clearing loop.

## Open items

- **Caching/invalidation strategy for repo-map artifacts** — resolved above: content-hash tag cache (not mtime, which is unreliable across worktree clones) + map keyed by `(slice_id, seed, budget, graph_version)`, invalidated on seed-hash change or upstream-slice landing (`graph_version` bump). Enforce deterministic rendering for cache stability.
- **SCIP is missing from the spec (§8.2).** Decide whether to make SCIP the Tier-1 edge source (recommended) given Phase 0 already builds the source; update §8.2 accordingly.
- **Edge provenance/confidence in the data model.** §12 `DependencyGraph` should carry a per-edge `source`/`confidence` field so Track D slicing can gate on low-confidence (heuristic) edges.
- **Dynamic-language residual risk.** Even SCIP/stack-graphs can't resolve pure-runtime dispatch (monkey-patching, reflection, dynamic import). Need a policy: flag unresolved/low-confidence references to human decision gates rather than fabricating edges ("wrong context worse than no context").
- **LSP harvesting scope.** Confirm whether opencode's spawned LSP servers reliably expose `callHierarchy` headless per language, or whether we drop live-LSP harvesting entirely in favor of SCIP + stack-graphs.
- **TOON vs CSV bench.** Run a concrete token/accuracy benchmark on representative adjacency lists with the production model before locking the edge encoder.
- **Monorepo scale.** Aider's map assembly was historically slow at ~4k+ files; validate PageRank + rendering cost on the largest corpus repo and cache aggressively.
