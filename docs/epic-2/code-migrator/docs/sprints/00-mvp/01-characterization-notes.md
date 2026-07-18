# 01 — Characterization / parity oracle (Round 2)

How the demo generates and certifies a trustworthy characterization oracle for
**sindresorhus/leven** (same-language JS spike).

## Flow

1. **`characterize` workflow** clones the target repo fresh into
   `$RENDER_WORKSPACE_DIR/characterize` (default: leven from GitHub).
2. **`characterizer` agent** reads the public API source and writes a single
   golden-master test file at the repo root.
3. **Certification** (Round 1 module in `examples/demo/src/lib/oracle.ts`) runs
   on the fixed oracle command — no parsing of agent free text.

## Fixed conventions

| Item | Value |
|------|--------|
| Oracle file | `__characterization__.test.mjs` (repo root) |
| Oracle command | `node --test __characterization__.test.mjs` |

The workflow hard-codes both. The agent prompt repeats them; certification never
derives the command from the agent's summary.

The oracle must use Node's built-in test runner, import the package public API
(e.g. `./index.js`), assert exact golden values over a representative corpus, and
stay deterministic (no clock, randomness, or network). The agent must **not**
modify source — only create the test file.

Before certification, the workflow checks `git status --porcelain`: only
`__characterization__.test.mjs` may appear. Any other change skips certification
so the mutation battery reads pristine `index.js`.

## Certification gates

Inside `ctx.step("certify", …)`:

1. **G0 — determinism** — `runDeterminismCheck` runs the oracle command N times
   (default 20); all must exit 0.
2. **G2 — mutation score** — `runMutationBattery` applies curated find/replace
   mutants to `index.js`, runs the oracle after each, restores the file always.
   Score = killed / (killed + survived); pass threshold default **≥ 0.75**.

Mutants live in `examples/demo/workflows/characterize/leven-mutants.ts` (four
behavioral edits verified against leven's current `index.js`).

`certifyOracle` returns `{ ok, gates }` where `ok` requires both gates green.

## Run it live

From `render-agents/examples/demo`:

```bash
./scripts/spike-characterize.sh
```

Requires `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (env or `examples/demo/.env`).
The script builds the monorepo, starts the in-memory gateway, and POSTs
`{"input":{}}` to `/workflows/characterize`. Inspect `certification` in the JSON
response or the operator UI.

Optional workflow input:

```json
{
  "repoUrl": "https://github.com/sindresorhus/leven",
  "determinismRuns": 20,
  "minMutationScore": 0.75
}
```

## CI / local checks (no model)

```bash
pnpm --filter @render-agents/example-demo typecheck
pnpm --filter @render-agents/example-demo test
```

Round 1 unit tests cover the certification module with injected deps; the
characterize workflow itself is exercised via the live spike script.

## Where goldens live

Golden expected values are **inside** `__characterization__.test.mjs`, written by
the LLM after reading the implementation. They are not checked into this repo —
each live run generates a fresh oracle in the ephemeral workspace checkout.
