# Track E — Prior art in automated / agentic migration at scale

> De-risks: spec §3 (approach & rationale), §13 (broad). Informs what has actually worked and where LLMs vs. deterministic transforms belong.

## Question

What can we learn from real, at-scale automated and agentic code-migration/refactoring systems?
- How did they combine **ASTs/deterministic transforms + LLMs + human gates**?
- What were their failure modes, verification strategies, and human-in-the-loop designs?
- **Where do deterministic transforms beat LLMs** (so we don't LLM what a compiler/codemod should do)?
- What agentic-harness patterns (sandboxing, agent-computer interface, verification loops) are proven?

## Why it's load-bearing

Avoids re-learning known lessons and over-using LLMs for tasks with deterministic solutions. Directly shapes the Implementer/Validator design and the deterministic-vs-LLM split.

## Sources to review

- **Google (2024): "AI-powered / assisted code migrations"** — ASTs + LLMs + human gates for real internal migrations; closest philosophy to ours.
- **AWS Q Code Transformation** — Java 8→17 upgrades at scale.
- Agentic harnesses: **SWE-agent** (agent-computer interface), **OpenHands** (formerly OpenDevin), **SWE-bench** (verification/eval harness), Aider.
- Deterministic transform tools (baselines): **OpenRewrite, ast-grep, Semgrep, jscodeshift/codemod (codemod.com), Grit.io**.
- Transpilers as baselines: **c2rust, py2many, GraalVM**; Sourcegraph Batch Changes.

## Findings

### 1. Google — "AI-powered code migrations" (2024/2025)

Two publications describe the same program: the research-blog overview ([research.google](https://research.google/blog/accelerating-code-migrations-with-ai/)) and two arXiv papers — the experience report ["How is Google using AI for internal code migrations?"](https://arxiv.org/html/2501.06972v1) and the case study ["Migrating Code At Scale With LLMs At Google"](https://arxiv.org/pdf/2504.09691) (32→64-bit ID migration).

**The division of labor is the headline lesson, and it matches our spec's philosophy almost exactly:**

- **LLMs own *edit generation*, not discovery or validation.** "The LLM role is focused on the edit generation. The parts where we need to identify locations at which to make changes, and where we need to validate that the right thing took place, are handled mostly using **deterministic AST techniques**." ([arxiv 2501.06972](https://arxiv.org/html/2501.06972v1))
- **Discovery is deterministic + filtered.** They use Kythe (semantic index) / Code Search / ClangMR to get a *superset* of candidate locations, then narrow with regex/heuristics (e.g. detect `(int)` casts, test IDs that fit in 32 bits) *before* handing files to the LLM. ([arxiv 2501.06972](https://arxiv.org/html/2501.06972v1))
- **Why not pure AST transforms?** They already had industrial-strength deterministic LSC tooling (Kythe/ClangMR) and deliberately chose LLMs for cases where "the contextual clues and the actual changes to be made have quite a bit of variance… difficult to write out in a deterministic code transformation pass." AST transforms remain better where a precise pattern exists; LLMs win where enumerating all edge cases as rules is infeasible (their JUnit3→JUnit4 case was "deemed infeasible" with pure AST "as there are just too many edge cases"). ([arxiv 2501.06972](https://arxiv.org/html/2501.06972v1))
- **Verification loop = build + unit tests + ML-repair, with best-of-N ranking.** Changes are auto-validated (compile + run tests); failures optionally trigger an ML "repair" (model fine-tuned on failed-build→fix diffs); multiple candidate diffs are generated per file-group and *scored/ranked* (closeness to example diffs, or Gemini-as-judge) to pick the one to land. ([arxiv 2501.06972](https://arxiv.org/html/2501.06972v1))
- **Cluster related files into one prompt.** Interdependent files (impl + header + test + interface) are migrated together so the model makes *consistent* cross-file changes; large context windows make this feasible. Splitting them causes inconsistency unless you feed already-migrated files back in. ([arxiv 2501.06972](https://arxiv.org/html/2501.06972v1)) — directly validates our per-slice interface contracts + "migrated upstream signatures" (spec §8.4).
- **Humans are the final gate + test authors.** Engineers review AI CLs like any other code and "add any missing tests to cover the changed lines." Rollout/landing stays human-driven to avoid regressions. ([research.google](https://research.google/blog/accelerating-code-migrations-with-ai/))

**Results:** 32→64-bit case study: 39 migrations, 3 devs, 12 months, 595 CLs / 93,574 edits; **74% of changes and 69% of edits LLM-generated**; **~50% self-reported reduction in end-to-end time** ([arxiv 2504.09691](https://arxiv.org/pdf/2504.09691)). Blog reports **80% of code modifications in landed CLs were AI-authored**, **>75% of AI-generated character changes land**, and **91% file-prediction accuracy in Java** ([research.google](https://research.google/blog/accelerating-code-migrations-with-ai/)).

**Failure modes / lessons:** (a) prompting alone is insufficient for anything but trivial migrations; (b) humans still had to **revert incorrect or unnecessary** model changes → motivated deeper investment in LLM-driven verification; (c) success should be measured as **end-to-end time saved**, not "% code written by AI" — even an imperfect first-draft CL saves time by localizing where changes are needed. ([arxiv 2501.06972](https://arxiv.org/html/2501.06972v1))

### 2. AWS Q Developer — Code Transformation (Java 8/11 → 17/21)

An IDE-integrated agent (VS Code/IntelliJ) that uploads the project to a secure build environment, generates a **transformation plan**, applies changes, and **iteratively re-builds and re-runs the existing unit tests to fix errors**, then returns a reviewable diff. ([AWS docs: how-CT-works](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/how-CT-works.html), [code-transformation](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/code-transformation.html))

**Approach traits worth copying:**
- **"Minimal changes necessary"** to reach target-JDK compatibility — a parity-first, no-net-new-behavior stance identical to our spec's non-goals.
- **Plan-then-apply with a human diff gate**; changes don't touch project files until accepted.
- **Staged transformations:** JDK upgrade first, then a *separate* dependency/library-upgrade transformation; a **YAML dependency-upgrade file** lets the user pin first/third-party target versions the tool can't infer. ([AWS docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/code-transformation.html))

**Limits (hard constraints):** Maven-only (3.8+), `pom.xml` must be in root; project must **build and test within 55 minutes**; transformed code retained only 30 days; some first-party deps need manual YAML/intervention. ([AWS docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/how-CT-works.html), [cloudthat](https://www.cloudthat.com/resources/blog/transforming-a-java-application-through-amazon-q)) Marketing throughput ("5 people upgraded 1,000 apps in 2 days, ~10 min each" — [AWS blog](https://aws.amazon.com/blogs/aws/upgrade-your-java-applications-with-amazon-q-code-transformation-preview/)) reflects the *homogeneous, well-scoped* nature of JDK upgrades.

**Critical nuance (deterministic core, LLM veneer):** independent analysis argues Amazon Q's Java upgrades lean heavily on **OpenRewrite recipes under the hood**, with LLMs handling orchestration/edge cases — "it creates the impression that LLM was responsible for the largest part of the changes, while it were very likely deterministic recipes." ([ecosystem4engineering](https://ecosystem4engineering.substack.com/p/automated-refactoring-ai-versus-deterministic), corroborated by [JAVAPRO](https://javapro.io/2026/02/04/the-open-source-deterministic-engine-maintaining-javas-next-30-years/): "both Amazon Q Developer and GitHub Copilot… rely on OpenRewrite under the hood"). **Takeaway: the marketed "AI migration" is a deterministic engine wrapped in an agent.** This is the single most important prior-art lesson for our deterministic-vs-LLM split.

### 3. Agentic-harness patterns (proven building blocks)

**SWE-agent — the Agent-Computer Interface (ACI).** The empirical finding: harness/interface design, not the model, is often the bottleneck. A tuned ACI beat a raw Linux shell by **+10.7 pts** on SWE-bench Lite (largest single factor in their ablation). Concrete, transferable design rules ([paper](https://arxiv.org/abs/2405.15793), [ACI docs](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md)):
- **Guardrailed edits:** a linter runs on every edit and **rejects syntactically-invalid edits before they apply** (prevents cascading failure). → We should reject on compiler/LSP diagnostics too (spec §6.2 already assumes LSP feedback).
- **Windowed file viewer (~100 lines):** too little context (30 lines) costs ~3.7 pts; whole-file loses focus. → validates our "wrong/too-much context is worse than no context" rule (spec §8.3).
- **Succinct search** (list matching files only, not verbose `grep -r` context) — information overload hurts.
- **Concise, specific per-turn feedback** (even "ran successfully, no output" messages).

**OpenHands (formerly OpenDevin) — sandbox & runtime architecture.** Client-server design: the agent backend talks over REST to an **action-execution server injected into a Docker container**; all shell/file/Python actions run in the sandbox and return observations via an **event stream**. The V1 Software Agent SDK adds native remote execution, a production server with sandboxing, pause/resume, **multi-agent delegation**, history restore, and context compression. Eval infra provisions **one isolated container per instance for massive parallelism (32+ workers)**. ([runtime docs](https://docs.openhands.dev/openhands/usage/architecture/runtime), [SDK paper](https://arxiv.org/html/2511.03690v1), [benchmarks](https://github.com/OpenHands/benchmarks)) → strongly validates our "ephemeral container per slice, Workflows fans out" model (spec §7.2, §11.1).

**SWE-bench / SWE-bench Verified — the verification harness pattern.** The gold standard for *test-based* verification: reproducible **Docker per instance**, apply patch, run tests, grade. The two-set test design is directly reusable as our parity oracle: **`FAIL_TO_PASS`** (the new behavior/target must satisfy) + **`PASS_TO_PASS`** (unrelated existing behavior must not regress). Verified = 500 human-confirmed-solvable problems; harness is containerized and parallelizable (Modal). ([overview](https://www.swebench.com/SWE-bench/), [harness](https://www.swebench.com/SWE-bench/reference/harness/), [Verified](https://openai.com/index/introducing-swe-bench-verified/)) → our characterization tests are exactly `PASS_TO_PASS` parity checks; integration/e2e nodes are the assembled-system equivalent.

**Aider — repo map + "plausibly correct" loop.** Aider pioneered the tree-sitter **repo map** (token-budgeted, PageRank-ranked signatures) our spec §8.3 is built on, and a loop that **repeatedly invokes the model until the patch passes pre-existing repo tests** before returning. ([SWE-bench synthesis above]) → validates repo-map + test-gated retry as the Implementer inner loop.

**Common harness pattern across all four:** *sandboxed execution + tool/ACI layer + generate→test→repair loop + best-of-N/retry + human/test gate.* This is precisely the Implementer/Validator design in the spec — the prior art confirms it rather than contradicting it.

### 4. Deterministic transforms & transpilers — where they beat LLMs

**Structural codemod engines** (AST/LST-based):
- **OpenRewrite** (Moderne): operates on a **Lossless Semantic Tree** (compiler-accurate, type-aware); recipes are **deterministic, idempotent, repeatable, composable, auditable, format-preserving**. "The same recipe produces the same output every time. No regex guesswork, no LLM nondeterminism, no regressions on re-run." Best for version/framework upgrades (Spring Boot, JUnit), dependency/CVE remediation, dead-code/feature-flag removal, standards enforcement — *at scale across many repos*. ([Moderne](https://moderne.ai/openrewrite), [InfoWorld primer](https://www.infoworld.com/article/4073173/a-practitioners-primer-on-deterministic-application-modernization.html))
- **ast-grep** (Rust/tree-sitter): fast multi-language structural search/replace; patterns look like code; YAML rules or Node API; scales across cores. ([repo](https://github.com/ast-grep/ast-grep/))
- **Grit / GritQL** (now Biome): declarative query+rewrite language, multi-language, module system with 200+ std patterns, scales to 10M+ line repos. ([gritql](https://github.com/biomejs/gritql/))
- **Semgrep**: pattern scanning, strongest for security/lint rule enforcement in CI (detection > transformation). ([codemod benchmark](https://github.com/codemod/benchmark))
- **jscodeshift / codemod.com (JSSG)**: imperative JS/TS codemods (recast-based, format-preserving); codemod.com's JSSG uses ast-grep as engine for typed, workspace-aware, cross-file codemods. ([codemod benchmark](https://github.com/codemod/benchmark), [hypermod](https://www.hypermod.io/blog/4-jscodeshift-vs-ast-grep))

**Where deterministic clearly wins** (converging conclusion across sources): **high-volume, low-variance, pattern-expressible, correctness-critical, repeated-across-repos** changes — API/signature renames, import rewrites, dependency/version bumps, annotation and boilerplate changes, mechanical syntax modernization. They give semantic preservation, reproducibility, idempotency, and auditability that LLMs cannot guarantee. The recommended pattern everywhere is **hybrid: run deterministic recipes first, then LLM the residual** (edge cases, remaining compile errors, context-dependent logic). LLMs are also good at *authoring/suggesting recipes* — a safer use than making edits directly. ([Moderne myths](https://www.moderne.ai/blog/understanding-openrewrite-beyond-the-myths), [ecosystem4engineering](https://ecosystem4engineering.substack.com/p/automated-refactoring-ai-versus-deterministic), [JAVAPRO](https://javapro.io/2026/02/04/the-open-source-deterministic-engine-maintaining-javas-next-30-years/))

**Transpilers (cross-language) — the sharp limit.** Deterministic transpilers guarantee *functional* translation but produce **unidiomatic, often unsafe** output:
- **c2rust**: "produces **unsafe** Rust code that closely mirrors the input C… primary goal is to preserve functionality." Output is "merely the first step"; making it safe/idiomatic "requires additional work… by a human, an LLM, a deterministic tool, or some combination." Notably c2rust itself ships a deterministic `c2rust-refactor` **and** an LLM `c2rust-postprocess` — and warns the LLM step "can introduce errors; use with a robust test suite." Hard limits: no variadic definitions, inline asm, `setjmp`/`longjmp`, `long double`/`_Complex`, comments lost. ([repo](https://github.com/immunant/c2rust), [known-limitations](https://c2rust.com/manual/docs/known-limitations.html))
- **py2many**: transpiles Python to multiple targets, aims for cleaner output but limited coverage of dynamic Python.
- **GraalVM**: a **polyglot runtime**, not a transpiler — it *runs* multiple languages interoperably rather than converting source. Relevant as an interop/shim strategy (transitional architecture, spec §4), not as a migration engine.

**Transpiler takeaway for us:** for cross-language ports, a transpiler is a *starting scaffold + parity guarantee*, and the LLM's job is the "lift to idiomatic" step — the exact inverse of within-language upgrades where deterministic tools finish the job. Either way, **a robust characterization/test suite is the safety net for both the deterministic step and the LLM cleanup** — which is our entire premise (spec §5, §10).

## Recommendation

**Adopt an explicit "deterministic-first, LLM-residual" pipeline inside every slice, with tests as the shared oracle.** The consistent lesson from Google, AWS Q (OpenRewrite-backed), and OpenRewrite/Moderne is: *do not LLM what a codemod can do deterministically.* Concretely, amend the spec's Implementer/Validator design (§6.1, §10) as follows:

1. **Split each slice's work into a deterministic pass and an LLM pass.** Route transformation classes per the decision rule below. The LLM only handles what the codemod leaves behind (residual compile errors, ambiguous/variant edits, cross-language idiom-lifting).
2. **Make discovery deterministic (Google's model).** Use the tree-sitter/LSP graph (spec §8) — not an LLM — to *find* change locations; narrow candidate sets with regex/heuristic filters before any LLM edit. LLM judgment is for boundaries/substitutions, not location enumeration.
3. **Validator = SWE-bench-style two-set gate.** Each slice must satisfy characterization tests as **`PASS_TO_PASS`** (parity: no regression) plus any slice-spec tests as **`FAIL_TO_PASS`** (target behavior present). Run in the per-slice Docker sandbox; this *is* the SWE-bench harness pattern.
4. **Inner loop = generate → build/test → repair → best-of-N (Google + Aider).** Feed LSP/compiler diagnostics back after each edit; on failure, attempt bounded LLM repair; generate N candidate diffs and rank by tests-passed (+ closeness-to-examples) before landing. Reject syntactically/type-invalid edits at the ACI boundary (SWE-agent guardrail).
5. **Cluster interdependent files into one LLM context (Google).** Migrate impl+header+test+interface together; once an upstream slice lands, feed its *migrated* target-language signatures downstream (already spec §8.4 — reinforce it).
6. **Consider embedding OpenRewrite / ast-grep / Grit as first-class tools the harness can call**, and let the LLM *author/parameterize recipes* (safer than direct edits) for repeated in-repo patterns. For cross-language ports where a transpiler exists (e.g. c2rust), use it as the parity-preserving scaffold and make the LLM's job "lift to idiomatic," gated by tests.
7. **Measure success as end-to-end time saved, not % AI-authored (Google), and keep humans at defined gates** (plan approval, decision resolution, final PR review) — consistent with spec §11.2 review-gate strictness.

### Deterministic-first decision rule (which class routes where)

Route a transformation to a **codemod (deterministic)** when it is *pattern-expressible, low-variance, high-volume, and correctness-critical*; route to an **LLM slice** when it is *context-dependent, variant-heavy, or requires semantic/idiom judgment*. Default to deterministic; fall through to LLM for the residual.

| Transformation class | Route | Tool / rationale |
| --- | --- | --- |
| Import/package/module path rewrites | **Codemod** | Pure structural; ast-grep/OpenRewrite. Zero variance. |
| Symbol/API/method renames, signature arg reorder | **Codemod** | Type-aware LST (OpenRewrite) or ast-grep; deterministic + idempotent. |
| Dependency/library/framework version upgrades (same lang) | **Codemod** | OpenRewrite recipes (Spring, JUnit3→4, Java 8→17). This is AWS Q's core. |
| Annotation / decorator / boilerplate changes | **Codemod** | Mechanical, pattern-matched. |
| Dead-code / feature-flag / deprecated-API removal | **Codemod** | OpenRewrite "remove" recipes; auditable. |
| Formatting, lint-rule enforcement, standards | **Codemod** | Semgrep/formatters; never an LLM job. |
| Mechanical syntax modernization (e.g. loops→streams where 1:1) | **Codemod** | Only if a clean AST rule exists; else LLM. |
| Cross-language *scaffold* (C→Rust, etc.) | **Transpiler + LLM** | c2rust/py2many for functional parity; LLM lifts to safe/idiomatic. |
| Cross-language *idiomatic port* of business logic | **LLM slice** | Variance too high for rules (Google's explicit reason). |
| Dependency **substitution** (no target-lang equivalent) | **LLM slice** | Requires semantic mapping + judgment (spec §13, Track F). |
| Control-flow / paradigm restructuring (OO↔functional, callback→async) | **LLM slice** | Context-dependent; no stable pattern. |
| Edge cases / residual compile errors after a codemod | **LLM slice (repair)** | Google's ML-repair step; the hybrid tail. |
| Test authoring / characterization generation | **LLM slice** | Requires behavioral understanding (Track B). |
| Resolving ambiguous change locations | **LLM slice** | After deterministic superset+filter narrows candidates. |

**Rule of thumb:** *If you can write the transform as a deterministic pattern that's correct across all instances, it's a codemod. If enumerating the edge cases as rules is infeasible, it's an LLM slice — but still gated by tests and, where possible, preceded by a deterministic pass that removes the easy 80%.*

## Open items

- **Toolchain selection & packaging:** which deterministic engines to embed by language pair — OpenRewrite (JVM: Java/Kotlin/Groovy + many frameworks), ast-grep/Grit (broad multi-language, tree-sitter), jscodeshift/JSSG (JS/TS), Semgrep (detection). Decide how the harness invokes them (native tool vs. MCP) and how the LLM authors/parameterizes recipes safely. Note: OpenRewrite's deepest coverage is JVM — for Python→Go/Rust corpus pairs (see `corpus.md`) deterministic coverage is thinner, so the LLM share is higher there.
- **Codemod-vs-LLM routing at planning time:** encode the decision rule into Phase-2 Planning (spec §7.1) so slices are tagged `deterministic | hybrid | llm` up front, feeding effort estimates and the DAG.
- **Transpiler-as-scaffold spike:** validate the c2rust→LLM-lift→tests loop on one cross-language corpus repo; measure how much of the "unsafe/unidiomatic" output the LLM can safely lift under characterization tests.
- **Best-of-N / ranking cost:** Google generates multiple candidate diffs and ranks them — quantify the token/container cost vs. parity-win against our concurrency budget (spec §13).
- **Verification depth beyond tests:** Google invested in *LLM-driven verification* after humans kept reverting unnecessary edits — decide whether to add a semantic-diff/LLM-review gate on top of the test gate to catch "correct-but-unnecessary" changes.
- **Measure end-to-end, not % AI-authored:** define the success metric (time-to-parity per slice, revert rate) rather than "% LLM-written," per Google's lesson.
