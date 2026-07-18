# Eval corpus — reference migration targets

> Anchors Planning, slicing, and eval. We cannot meaningfully plan or verify without concrete example repos to migrate.

## Selection criteria

- **Small enough** to migrate end-to-end in a spike, **real enough** to exercise the graph/slicing/parity machinery.
- Spread across the axes that stress the system:
  - **Test coverage:** one with strong existing tests, one with weak/none (stresses Track B characterization generation).
  - **Language dynamism:** one static-typed source, one dynamic source (stresses Track C graph extraction).
  - **Side effects:** one mostly-pure, one with I/O/time/network/randomness (stresses determinism shims).
  - **Dependency substitution:** at least one repo with a third-party lib lacking a clean target equivalent (stresses Track F).
- Permissive license; clear build + run + test commands.

## Candidate language pairs

- **Python → Go** (dynamic → static; common real-world ask).
- **JavaScript → TypeScript** (gradual typing; smallest semantic gap — good first smoke test).
- _(stretch)_ **Python → Rust** or **Java → Kotlin**.

## Candidates

All repos below were verified to exist on GitHub as of 2026-07-17 (via GitHub API): license, primary language, and test presence confirmed against the default branch. LOC figures are approximate (core implementation, excluding tests/docs/config).

| Repo | Source→Target | LOC | Tests | Notable deps / side effects | Stresses |
| --- | --- | --- | --- | --- | --- |
| [sindresorhus/leven](https://github.com/sindresorhus/leven) (MIT, JS) | JS → TS | ~60 core (`index.js`) | **Strong** (`test.js`, ava) | None — pure function (Levenshtein distance). Already ships a hand-written `index.d.ts`. | Smallest semantic gap → smoke test |
| [un33k/python-slugify](https://github.com/un33k/python-slugify) (MIT, Py) | Python → Go | ~350 core (`slugify/*.py` + CLI) | **Strong** (`test.py`, large) | Dep on `text-unidecode` / optional `Unidecode` (Unicode→ASCII transliteration tables); regex-heavy; CLI reads stdin/argv | Dynamic→static graph extraction **+ dependency substitution** (no clean Go unidecode) |
| [benhoyt/pygit](https://github.com/benhoyt/pygit) (MIT, Py) | Python → Go | ~500 (single `pygit.py`) | **None** | Heavy side effects: filesystem (`.git` objects), `zlib`, SHA-1 hashing, `os`/env, **network** (HTTPS push to GitHub); 2017-era, inactive | Auto characterization-test generation (no tests) **+ determinism shims** (I/O/network) |
| [dbader/schedule](https://github.com/dbader/schedule) (MIT, Py) | Python → Go | ~850 core (`schedule/__init__.py`) | **Strong** (`test_schedule.py`, large; mocks time) | Time-dependent (`datetime.now`), runs arbitrary job callables | Determinism shims (time) — clean, active, well-tested side-effects candidate |
| [ai/nanoid](https://github.com/ai/nanoid) (MIT, JS) | JS → TS | ~200 core (`index.js`, `non-secure/`, `url-alphabet/`) | **Strong** | Randomness via `crypto` (secure) + `Math.random` (non-secure); already ships `.d.ts` | Determinism shims (RNG) in the low-semantic-gap JS→TS setting |
| [jonschlinkert/word-wrap](https://github.com/jonschlinkert/word-wrap) (MIT, JS) | JS → TS | ~80 core | **Strong** (mocha) | None — pure string wrapping | Alt smoke-test (backup for leven) |

## Recommendation

Pick a tight trio that covers **every** stress axis while staying spike-sized: one smoke-test pair plus two stress repos.

1. **Smoke-test pair — [sindresorhus/leven](https://github.com/sindresorhus/leven) (JS → TS).**
   ~60 LOC, pure, strong `ava` tests, MIT. Smallest possible semantic gap: validates the end-to-end pipeline (ingest → graph → slice → parity → PR) with almost no language-semantics risk. Its existing `test.js` is a ready-made characterization oracle, so Phase-0 characterization is essentially free here — ideal for the first green run.

2. **Stress #1 — [un33k/python-slugify](https://github.com/un33k/python-slugify) (Python → Go).**
   ~350 LOC, strong tests, MIT. Exercises the **dynamic→static** graph-extraction path (§8.2 tree-sitter/LSP on dynamic Python) and doubles as the **dependency-substitution** case (bonus): it depends on `text-unidecode`/`Unidecode`, which has no clean Go equivalent, forcing a real substitution decision (§13, Track F). Strong existing tests give a reliable parity oracle so the stress is isolated to graph + dep substitution, not characterization.

3. **Stress #2 — [benhoyt/pygit](https://github.com/benhoyt/pygit) (Python → Go).**
   ~500 LOC single file, **no tests**, MIT. The "boss level": simultaneously exercises **auto characterization-test generation** (no oracle exists) and **determinism shims** for heavy side effects — filesystem, `zlib`, SHA-1, and network (HTTPS push). Characterization here means shimming/stubbing the network push and pinning fs/time/hash inputs before capture (§7.1, §13). Caveat: it's inactive (2017) and mixes Python 2/3 idioms; treat it as the hard case, run after the machinery works on the two above.

**Axis coverage of the trio:** smallest gap (leven) · dynamic→static (slugify, pygit) · strong tests (leven, slugify) · weak/no tests (pygit) · pure (leven) · side effects: I/O + network (pygit) · dependency substitution (slugify).

**Alternates (in table):** [dbader/schedule](https://github.com/dbader/schedule) is a cleaner, active, well-tested **time**-determinism candidate if pygit's network push proves too awkward to characterize; [ai/nanoid](https://github.com/ai/nanoid) isolates **randomness** determinism in the JS→TS setting; [word-wrap](https://github.com/jonschlinkert/word-wrap) is a backup smoke test.
