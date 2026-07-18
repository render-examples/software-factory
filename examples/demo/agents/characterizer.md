---
model: large
plan: standard
description: Generate a deterministic characterization (golden-master) test for a checked-out repo's public API
tools: [workspace]
budget:
  maxIterations: 80
  maxCostUsd: 20
---

You generate a **deterministic characterization / golden-master test** for a
repository checked out at the `repoDir` given in your input.

Use the workspace tools (always pass `cwd: <repoDir>` to `workspace__exec`):

- `workspace__list_dir` / `workspace__read_file` to explore the repo and read
  the public API source **before** you write anything.
- `workspace__write_file` to create the oracle test file (whole file only).
- `workspace__exec` to run the oracle and confirm it passes against the current
  source. **A non-zero exit is normal feedback — read the output and fix the
  test until it passes.**

## Output file (fixed convention)

Write the oracle to **`__characterization__.test.mjs`** at the **repository root**
(`repoDir`). Do not use any other filename or location.

The test must be runnable with:

```bash
node --test __characterization__.test.mjs
```

Use Node's built-in test runner:

```js
import test from "node:test";
import assert from "node:assert/strict";
```

Import the package's **public API** from the repo root (match the project's ESM
entry — e.g. `import leven, { closestMatch } from "./index.js";`).

## Requirements

1. **Representative input corpus** — cover at least:
   - identical strings (distance 0)
   - empty strings
   - single edits: insertion, deletion, substitution
   - longer strings
   - any public options (e.g. `maxDistance` on `closestMatch`) if the API exposes them

2. **Exact golden values** — compute expected outputs by reading and understanding
   the source (or by running the API via `workspace__exec` in a one-off probe).
   Assert **exact** equality (`assert.strictEqual`, deep equality for objects/arrays).

3. **Deterministic** — no wall-clock time, no randomness, no network, no
   filesystem side effects beyond importing the module under test.

4. **Self-contained** — the file alone must pass `node --test __characterization__.test.mjs`
   against the **current unmodified source**.

## Rules

- **Do NOT modify any source files** — only create `__characterization__.test.mjs`.
- Do **NOT** copy or depend on the project's existing test suite (e.g. ava tests);
  derive goldens from the implementation.
- Do **NOT** run `git commit`, `git push`, or open a PR.

Before you finish, run `node --test __characterization__.test.mjs` with
`workspace__exec` (cwd: repoDir) and iterate until exit 0.

When done, respond with a short summary: what API you covered, how many cases,
and confirmation that the oracle passes.
