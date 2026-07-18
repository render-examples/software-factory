# Track F — Cross-language dependency substitution

> De-risks: spec §13 ("cross-language dependency substitution (libraries with no target equivalent)"), §8.4 (migrated upstream signatures).

## Question

How do we map source-language libraries/stdlib to target-language equivalents — and what do we do when **no equivalent exists**?
- How do existing transpilers/migrators map stdlib + third-party deps?
- Shim/adapter strategies when there's no 1:1 target library.
- How is a substitution decision surfaced for human sign-off (§7.1 Phase 1 decisions) and recorded (Decision data model, §12)?
- How does a substitution propagate to downstream slices' interface contracts (§8.4)?

## Why it's load-bearing

Dependency substitution is where "behavioral parity" is most at risk (subtle library semantics differ). It also gates slices — a downstream slice can't bind to an upstream contract until the substitution is chosen.

## Sources to review

- Transpiler dependency-mapping approaches (c2rust, py2many, JVM interop, TypeScript `@types` ecosystem).
- OpenRewrite dependency/recipe management for library upgrades/replacements.
- Prior migration writeups (Google/AWS from Track E) on library mapping specifically.
- Package ecosystem mapping resources (e.g. "X for language Y" equivalence catalogs).

## Findings

### 1. How existing transpilers/migrators map stdlib + third-party deps

The consistent pattern across mature tools is a **curated mapping table + fallback tiers**, never pure LLM guesswork:

- **c2rust (C→Rust)** maps C stdlib types/functions to the `libc` crate and emits calls against it, deliberately preserving semantics/ABI over idiom (`malloc`/`free`/`memcpy` stay as `libc` calls; pointers become raw pointers). Fidelity is the explicit design goal, so output is "unidiomatic but behaviorally identical." When the mapped crate is unavailable (e.g. kernel modules), users hand-redefine the type aliases and reimplement the handful of functions the output relies on — i.e. a **manual shim** for the substitution gap. ([C2Rust manual](https://c2rust.com/manual/c2rust-transpile/index.html), [emmtrix: Automatic C to Rust Translation](https://www.emmtrix.com/wiki/Automatic_C_to_Rust_Translation), [Immunant: Transpiling a Kernel Module to Rust](https://immunant.com/blog/2020/06/kernel_modules/))
- **py2many (Python→C++/Rust/Go/Julia/…)** uses a **plugin-based dispatch map** (`small_dispatch_map`) for a curated subset of builtins/stdlib, a **topological sort of modules** so type info propagates across imports before transpilation, and type inference (pytype/typpete). Where no equivalent exists it either maps to a target-native package, falls back to a **small hand-written runtime shim** (e.g. Go lacks an ergonomic `range(3,9,2)`), or — in the `py-stdlib` sub-project — **reimplements the top ~100 stdlib functions** in statically-typed Python via FFI, LLM-assisted. ([py2many overview](https://adsharma.github.io/py2many/), [py2many CHANGELOG](https://github.com/py2many/py2many/blob/main/CHANGELOG.md), [py2many/py-stdlib](https://github.com/py2many/py-stdlib))
- **PyJL (Python→Julia)** documents the general decision tree explicitly: (1) map the module call to a **native target package** (best case — e.g. Python `json` → Julia `JSON`); (2) simulate/wrap behavior in the target; or (3) **call back into the source language via FFI** (`PyCall`) when neither works. This 3-way choice (native equivalent / reimplement / interop bridge) is the canonical menu of options. ([PyJL thesis PDF](https://fenix.tecnico.ulisboa.pt/downloadFile/1126295043839705/98684_Miguel_Marcelino_resumo.pdf), [PyJL paper PDF](https://web.ist.utl.pt/antonio.menezes.leitao/ADA/documents/publications_docs/2022_TranspilingPythonToJuliaUsingPyJL.pdf))
- **TypeScript `@types` / DefinitelyTyped** is the reference model for **decoupling interface from implementation**: `.d.ts` declaration files describe the shape/contract of an untyped JS library with no runtime code, resolved via `node_modules/@types` (DefinitelyTyped) or hand-written project-local `.d.ts`. Fallback tiers are built-in: bundled types → DefinitelyTyped → your own `.d.ts` → `declare module "x";` (types become `any`, silencing errors). Key lesson: you only need to declare the **subset of the surface you actually use**. ([TS Handbook: Type Declarations](https://www.typescriptlang.org/docs/handbook/2/type-declarations), [Ambient declarations](https://alistair.sh/ambient-declarations))
- **JVM interop / GraalVM polyglot** is the "keep calling the source library" escape hatch. GraalPy lets Java/Kotlin `eval` Python and cast the returned polyglot `Value` to a hand-written Java interface whose method names map to the Python object; args/returns are coerced by the Truffle interop protocol, with `register_interop_type` to customize mapping of otherwise-unsupported types (e.g. numpy). Caveat: reliable mainly for core types with defined mappings. This is the runtime analog of PyJL's FFI option — use the original lib behind a target-language interface when no port exists. ([GraalPy Java SE guide](https://github.com/graalvm/graal-languages-demos/tree/main/graalpy/graalpy-javase-guide), [GraalVM polyglot](https://www.graalvm.org/jdk23/reference-manual/polyglot-programming/), [GraalVM Python interop](https://www.graalvm.org/jdk24/reference-manual/python/Interoperability/))
- **AWS Q Developer (Java 8→17)** shows the *governance* pattern we want: it builds a **transformation plan** listing "new dependency versions, major code changes, suggested replacements for deprecated code," upgrades a fixed **allow-list of popular libraries/frameworks** to compatible majors, directly replaces deprecated APIs, then iterates build+unit-test to fix errors. Crucially, deps the tool "might not otherwise know to upgrade" are supplied via an explicit **`dependency-upgrade.yaml`** (`identifier`, `targetVersion`, `originType: FIRST_PARTY|THIRD_PARTY`) — a machine-readable, human-authored substitution manifest surfaced for review during planning. ([How CT works](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/how-CT-works.html), [Upgrading Java versions](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/code-transformation.html), [Selective transformation deep dive](https://aws.amazon.com/blogs/devops/amazon-q-developer-java-upgrades-a-deep-dive-into-new-selective-transformation-feature/))
- **OpenRewrite** is the deterministic model for **same-language dependency replacement**: `ChangeDependency` / `ChangeManagedDependency` rewrite build coordinates (`oldGroupId/ArtifactId` → `newGroupId/ArtifactId`, glob-supported), paired with `ChangeType` to rewrite call sites. Key gotcha directly relevant to us: a coordinate swap **plus** call-site rewrite can still fail to compile if the lib is pulled in **transitively** — you must also `AddDependency` (`acceptTransitive`). Substitution is a *composite* recipe (build + code + transitive), not a single edit. ([ChangeDependency](https://docs.openrewrite.org/recipes/java/dependencies/changedependency), [transitive-dep pitfall #6552](https://github.com/openrewrite/rewrite/issues/6552))
- **Google's internal AI migrations (2024)** confirm the deterministic-vs-LLM split: location discovery and validation are **AST/symbol-based (Kythe/Code Search)**; the LLM is scoped to **edit generation** inside a test-driven loop, and humans review like any CL. Dependency/interface files are auto-added to the change superset via symbol cross-references. ([Google Research blog](https://research.google/blog/accelerating-code-migrations-with-ai/), [arXiv 2501.06972](https://arxiv.org/html/2501.06972v1))

### 2. Shim/adapter strategies when there is no 1:1 target library

The dominant pattern is the **Anti-Corruption Layer (ACL)** — a Facade + Adapter + Translator boundary that exposes a **target-native interface expressed in our own domain terms** and hides the substitute library entirely. The rule of thumb: an Adapter changes the *shape* of a call (method signatures); an ACL changes the *meaning* (conceptual/semantic translation). For substitution, the ACL is what protects parity: subtle semantic differences (error codes, statuses, date parsing, null handling) get absorbed and normalized **in one place**, and the substitute lib's types never leak into the migrated code. Guidance: use a thin adapter below ~3 integration points/cosmetic differences; a full ACL when semantics diverge; and **write tests specifically for the translation logic** because "status mappings and error codes are where subtle bugs hide." ([Azure: Anti-Corruption Layer](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer), [ACL — the pattern nobody implements](https://medium.com/@antonellosemeraro/the-anti-corruption-layer-the-pattern-nobody-implements-fc270a91279c), [ACL in .NET](https://medium.com/@adrianbailador/anti-corruption-layer-in-net-protecting-your-domain-from-external-apis-2e239532d195))

Concrete ladder of substitution strategies (least→most risk of divergence), synthesizing the tools above:
1. **1:1 native equivalent** — direct swap where a target lib matches behavior (json→JSON, cobra→clap). Still requires a parity check on edge semantics.
2. **Native equivalent behind an ACL** — swap + thin/fat translation layer to normalize semantic gaps. Default for anything non-trivial.
3. **Reimplement the used subset** — port only the functions actually called (c2rust's manual libc, py-stdlib's top-100, TS "declare only what you use"). Bounded surface = bounded parity risk.
4. **Interop / FFI bridge to the source library** — GraalVM polyglot, PyCall, C ABI. Guarantees identical behavior but is a **transitional shim** (§4/§9.1 spec), not an end state; carries runtime/packaging cost and violates "clean target-language output" if left in.

**Parity is genuinely load-bearing here** — cross-language library semantics differ in ways that produce silent bugs, so every substitution needs a characterization-test gate, not just "compiles + typechecks":
- **Float semantics**: FMA, x87 80-bit intermediates, reassociation under `-ffast-math`, flush-to-zero denormals differ across targets/toolchains and change results. ([Floats don't agree with themselves](https://docs.merca.earth/blog/floats-dont-agree-with-themselves))
- **Sort/comparator semantics**: NaN/`-0.0` ordering and stability differ (`sort.Float64s` puts NaN first; IEEE total order puts `-NaN < … < +NaN`; JAX vs PyTorch argsort disagree on subnormals under FTZ; Go stable-merge breaks on non-strict-weak-order comparators). ([Go math #56491](https://github.com/golang/go/issues/56491), [Go sort #41951](https://github.com/golang/go/issues/41951), [JAX argsort #24280](https://github.com/jax-ml/jax/issues/24280))
- **String collation**: ICU version drift silently changes sort order (accented chars) and can corrupt ordered indexes — the same class of bug appears when swapping a source lib's collation for a target's. ([ICU collation version drift](https://www.michal-drozd.com/en/blog/icu-collation-version-drift/))

Implication: the substitution decision record must name the **specific semantic axes at risk** and bind to characterization tests that exercise them.

### 3. Surfacing substitution decisions for sign-off + recording (spec §7.1 Phase 1, §12 Decision)

The proven pattern (AWS transformation plan, Google human-review gate, ADR/MADR literature) is: **agent proposes a defaulted recommendation with alternatives + rationale; human accepts/overrides at a gate; the resolution is recorded immutably and versioned in the repo.** This maps cleanly onto the spec:
- Phase 1 Research already "surfaces the most important architecture & dependency questions with intelligent, defaulted recommendations for human sign-off" (§7.1). A dependency substitution is exactly such a question and should be emitted as a `Decision` row (§12: `question, recommendation, resolution, resolver, timestamp`).
- The mature record format is **ADR/MADR**: `status (proposed|accepted|superseded|deprecated)`, `context/problem`, `decision drivers`, **considered options (required — show what was rejected)**, `decision outcome`, `consequences`, `confirmation` (how we'll verify it worked), YAML front-matter for metadata. **Immutable + superseded-by links**, one file per decision, numbered, in version control. ([Nygard/Fowler ADR](https://martinfowler.com/bliki/ArchitectureDecisionRecord.html), [MADR fields & operations](https://hidekazu-konishi.com/entry/architecture_decision_records_templates_and_operations.html), [ADR org repo](https://github.com/architecture-decision-record/architecture-decision-record))
- AWS's `dependency-upgrade.yaml` (`identifier / targetVersion / originType`) is the concrete precedent for a **machine-readable substitution manifest** that a human edits and the agent consumes — a natural fit for both the spec's control-plane "Key decisions" input (§11.2) and the per-slice agent-log `decisions:` field (§9.3).

This is a **Decision** (§12) specialized for dependency substitution — see the schema in Recommendation. It should be born in Phase 1 (repo-global substitutions, e.g. "HTTP client lib"), but can also be raised mid-slice when a local dependency has no equivalent, blocking that slice until resolved.

### 4. Propagation to downstream slices' interface contracts (spec §8.4)

A substitution is a **cross-cutting node**, not a leaf: the migrated symbols that touch the substituted library get **target-language signatures** that differ from the source, and §8.4 already prescribes feeding *migrated upstream signatures* (target interface, not source) to downstream slices so they bind to the new contract. Substitution plugs directly into that machinery:
- The chosen substitution defines an **interface boundary** (the ACL's target-native interface). That boundary **is** the `SliceInterface` public contract (§12) for the slice that owns the dependency, and it becomes the "migrated upstream signature" (§8.4) that downstream slices see instead of the source library's API.
- OpenRewrite's transitive-dependency lesson generalizes: a substitution isn't done when the owning slice compiles — **every downstream slice that referenced the old library's types must be re-pointed** to the ACL interface. So the decision record must carry an explicit `affected_slices` / blast-radius list derived from the dependency graph (who `imports`/`calls` the substituted symbols), and those slices' interface contracts must be regenerated once the substitution lands. This gates the DAG: a downstream slice can't start until its upstream substitution contract is `accepted` and stable.
- Behavioral anchors (§8.4) apply: link the substitution to the characterization tests that pin the at-risk semantic axes, so the downstream Implementer sees the parity oracle alongside the new signature.

### 5. Existing "X library for language Y" equivalence catalogs

- **rinku** — CLI + curated DB, **180+ Go→Rust mappings** (300+ libs, 25+ categories: gin→axum, cobra→clap, gorm→sea-orm, zap→tracing), also JS→Go, Python→Rust; `--unsafe` to include libs with known vulns. Closest thing to a machine-consumable seed catalog for our target pairs. ([rinku](https://github.com/marvai-dev/rinku))
- **Package Pal / PackagePal** — AI (Gemini) semantic matcher across 15+ languages, web + VS Code hover ("what's the Go version of `requests`?"), returns top-3 with docs/snippets. Its author explicitly found a **pure lookup table fails** — best equivalent depends on *which behavior* of the source lib you use (requests' sessions vs. retries) and drifts as ecosystems evolve; semantic/AI matching outperforms static tables. Validates our "LLM proposes, catalog seeds, human confirms" approach. ([Package Pal](https://packagepal.dev/), [author writeup](https://dev.to/sagar_kashyap_d20f1d5fa65/i-built-a-tool-that-finds-package-equivalents-across-programming-languages-5122))
- **ContinuumIO/package-name-map** — cross-ecosystem name-mapping DB (TOML→JSON), models **1:many** mappings and package splits (conda↔debian). Useful schema precedent for the fact that one source lib may map to several target packages. ([package-name-map](https://github.com/ContinuumIO/package-name-map))
- Language-native curated lists (awesome-*, Are-we-* pages) remain the human-maintained ground truth per ecosystem.

**Takeaway:** seed with catalogs (rinku for Go↔Rust), let the LLM propose with rationale, but **treat all of it as a recommendation requiring a parity-tested, human-signed decision** — the catalogs themselves warn that name-level equivalence ≠ behavioral equivalence.

## Recommendation

**Adopt a three-tier substitution pipeline that terminates in a reviewed, parity-tested decision record, and wire that record into the slice interface contract.**

1. **Catalog-seeded proposal, LLM judgment, deterministic where possible.**
   - Seed a `dependency_substitutions` catalog from rinku/package-name-map for the target language pair; the Planner LLM proposes a substitution *with alternatives and rationale* (never silent), consistent with spec §8.1 ("LLM's role is judgment … deciding dependency substitutions").
   - For same-language coordinate/version bumps, prefer deterministic OpenRewrite-style recipes (and remember transitive `AddDependency`) over LLM edits (per Google's deterministic-vs-LLM split, Track E).
2. **Choose a strategy from the risk ladder** (native swap → native+ACL → reimplement-used-subset → FFI/interop shim), defaulting to **native-equivalent-behind-an-ACL** for anything non-trivial. Reserve FFI/interop as an explicit *transitional shim* (§spec transitional shim) that must be scheduled for removal, not shipped in the clean target output (§9.5).
3. **Emit a Dependency Substitution Decision Record (DSDR)** — a specialization of the §12 `Decision` model, surfaced in Phase 1 for global deps and mid-slice for local ones, blocking dependent slices until `accepted`.

**Proposed DSDR schema** (Postgres row + materialized ADR/MADR-style markdown in `.agent-log/`, immutable + superseded-by):

```yaml
# .agent-log/<slice-id or _global>/decision-subst-<seq>-<slug>.md  (front-matter)
id: dsdr-0007
type: dependency_substitution        # subtype of Decision (§12)
status: proposed                     # proposed | accepted | superseded | deprecated
superseded_by: null                  # link, ADR-style; records are immutable
source_dependency:
  ecosystem: pypi
  name: requests
  used_symbols: [Session, get, post, Response.json, Timeout]   # only the surface actually used
target_language: go
# ---- proposal ----
recommendation:
  strategy: native_behind_acl        # native | native_behind_acl | reimplement_subset | interop_shim
  target_dependency: { ecosystem: gomod, name: net/http, plus: [hashicorp/go-retryablehttp] }
  acl_interface: HttpClient          # the target-native interface the migrated code binds to
  rationale: "requests used for sessions+retry; net/http + retryablehttp covers both"
considered_options:                  # REQUIRED (MADR) — what was rejected & why
  - { target: resty, rejected_because: "different retry/backoff semantics" }
drivers: [behavioral_parity, maintenance, license, transitive_footprint]
# ---- parity risk (load-bearing) ----
semantic_risk_axes: [timeout_default, redirect_following, connection_pooling, error_taxonomy]
parity_tests: [char-test://requests_session_retry, char-test://timeout_behavior]   # §8.4 behavioral anchors
confirmation: "characterization suite green against ACL interface"
# ---- graph / DAG linkage ----
owning_slice: slice-42
slice_interface_ref: SliceInterface#slice-42                 # §12 SliceInterface (the ACL interface == public contract)
affected_slices: [slice-51, slice-63]        # derived from dependency graph: who imports/calls used_symbols
propagates_as: migrated_upstream_signature   # §8.4 — downstream binds to target interface, not source lib
# ---- governance (§7.1, §12 Decision) ----
resolver: null                       # human at review gate
resolved_at: null
review_gate: blocking                # blocking | proceed-with-default
```

**Linkage to slice interface contracts (the load-bearing part):**
- The DSDR's `acl_interface` **is** the owning slice's `SliceInterface` public contract (§12) and the §8.4 "migrated upstream signature." Downstream slices bind to `slice_interface_ref`, never to the source library's API.
- `affected_slices` is computed from the machine graph (§8.1): the set of slices whose symbols `import`/`call` `used_symbols`. Those slices are **DAG-gated** on `status: accepted` and get their interface contracts regenerated once the substitution lands (the transitive-dependency lesson from OpenRewrite, generalized).
- `parity_tests` are the behavioral anchors (§8.4) that pin `semantic_risk_axes`; a substitution is "done" only when they're green — matching principle "parity is the contract" (§5).
- Global substitutions are also surfaced as control-plane "Key decisions" inputs (§11.2), mirroring AWS's `dependency-upgrade.yaml`.

## Open items

- **Catalog bootstrapping & freshness**: which seed catalogs per target pair (rinku for Go↔Rust; is there a Python→Go equivalent, or do we generate one LLM-assisted?), and how to keep them from going stale (the Package Pal "lookup tables rot" warning).
- **Blast-radius computation cost**: deriving `affected_slices` requires querying the symbol graph for every `used_symbol`; confirm the §8.1 Postgres/networkx graph exposes this cheaply and stays fresh as slices land.
- **FFI/interop shim lifecycle**: define the rule for when an `interop_shim` is acceptable as a *transitional* measure vs. a hard blocker, and how its scheduled removal is tracked in the DAG (avoid shipping polyglot bridges in "clean target output," §9.5).
- **Semantic-risk-axis taxonomy**: build a reusable checklist of parity-risk axes per category (HTTP client, date/time, decimal/float, collation/sort, serialization) so the Planner reliably names them in `semantic_risk_axes` rather than improvising.
- **DSDR ↔ Decision unification**: confirm the DSDR is stored as a subtype of the §12 `Decision` table (shared `question/recommendation/resolution/resolver/timestamp`) with the extra fields above, so the dashboard's decision log is uniform.
- **Superseding semantics in a DAG**: if a substitution is superseded after downstream slices already bound to it, define the re-migration/invalidation path (ADRs are immutable, but bound code is not).
