import { describe, expect, it } from "vitest";
import {
  certifyOracle,
  runDeterminismCheck,
  runMutationBattery,
  type DeterminismResult,
  type MutationResult,
  type Mutant,
  type OracleExecDeps,
} from "../src/lib/oracle.js";

function makeDeps(overrides: {
  exec?: (cmd: string, cwd: string) => Promise<{ code: number; output: string }>;
  files?: Record<string, string>;
  onWrite?: (path: string, content: string) => void;
}): OracleExecDeps {
  const files = new Map(Object.entries(overrides.files ?? {}));
  return {
    exec: overrides.exec ?? (async () => ({ code: 0, output: "" })),
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path: string, content: string) => {
      overrides.onWrite?.(path, content);
      files.set(path, content);
    },
  };
}

describe("runDeterminismCheck", () => {
  it("passes when all runs exit 0", async () => {
    let calls = 0;
    const result = await runDeterminismCheck(
      "node --test oracle.test.mjs",
      "/repo",
      makeDeps({
        exec: async () => {
          calls++;
          return { code: 0, output: "ok" };
        },
      }),
      { runs: 20 },
    );

    expect(result.ok).toBe(true);
    expect(result.runs).toBe(20);
    expect(result.greenRuns).toBe(20);
    expect(calls).toBe(20);
  });

  it("fails on the first non-zero exit and records greenRuns", async () => {
    let calls = 0;
    const result = await runDeterminismCheck(
      "node --test oracle.test.mjs",
      "/repo",
      makeDeps({
        exec: async () => {
          calls++;
          return calls < 5 ? { code: 0, output: "" } : { code: 1, output: "fail" };
        },
      }),
      { runs: 20 },
    );

    expect(result.ok).toBe(false);
    expect(result.runs).toBe(20);
    expect(result.greenRuns).toBe(4);
    expect(calls).toBe(5);
    expect(result.detail).toContain("run 5/20");
  });
});

describe("runMutationBattery", () => {
  const repoDir = "/repo";
  const testCmd = "node --test characterization.test.mjs";
  const filePath = `${repoDir}/index.js`;
  const original = "export const distance = (a, b) => a < b ? b - a : a - b;";

  it("kills mutants when tests fail and survives when tests pass", async () => {
    const mutants: Mutant[] = [
      { id: "flip-lt", file: "index.js", find: "a < b", replace: "a <= b" },
      { id: "noop-plus", file: "index.js", find: "b - a", replace: "b - a" },
      { id: "swap-minus", file: "index.js", find: "b - a", replace: "b + a" },
    ];

    const writes: Array<{ path: string; content: string }> = [];
    const result = await runMutationBattery(repoDir, testCmd, mutants, makeDeps({
      files: { [filePath]: original },
      onWrite: (path, content) => writes.push({ path, content }),
      exec: async (_cmd, _cwd) => {
        const current = writes.at(-1)?.content ?? original;
        return current.includes("a <= b") || current.includes("b + a")
          ? { code: 1, output: "assertion failed" }
          : { code: 0, output: "" };
      },
    }));

    expect(result.killed).toEqual(["flip-lt", "swap-minus"]);
    expect(result.survived).toEqual([]);
    expect(result.errored).toEqual(["noop-plus"]);
    expect(result.score).toBe(1);
    expect(writes.at(-1)).toEqual({ path: filePath, content: original });
  });

  it("records survived mutants when tests still pass", async () => {
    const mutants: Mutant[] = [
      { id: "weak-mutant", file: "index.js", find: "a < b", replace: "a <= b" },
    ];

    const writes: Array<{ path: string; content: string }> = [];
    const result = await runMutationBattery(repoDir, testCmd, mutants, makeDeps({
      files: { [filePath]: original },
      onWrite: (path, content) => writes.push({ path, content }),
      exec: async () => ({ code: 0, output: "" }),
    }));

    expect(result.killed).toEqual([]);
    expect(result.survived).toEqual(["weak-mutant"]);
    expect(result.score).toBe(0);
    expect(writes.at(-1)).toEqual({ path: filePath, content: original });
  });

  it("marks mutants errored when find is absent and leaves the file untouched", async () => {
    const writes: string[] = [];
    const result = await runMutationBattery(
      repoDir,
      testCmd,
      [{ id: "missing-find", file: "index.js", find: "NOT_PRESENT", replace: "X" }],
      makeDeps({
        files: { [filePath]: original },
        onWrite: (_path, content) => writes.push(content),
      }),
    );

    expect(result.errored).toEqual(["missing-find"]);
    expect(result.killed).toEqual([]);
    expect(result.survived).toEqual([]);
    expect(result.score).toBe(0);
    expect(writes).toEqual([]);
  });

  it("returns score 0 for an empty battery without throwing", async () => {
    const result = await runMutationBattery(repoDir, testCmd, [], makeDeps({}));
    expect(result.score).toBe(0);
    expect(result.killed).toEqual([]);
    expect(result.survived).toEqual([]);
    expect(result.errored).toEqual([]);
  });

  it("returns score 0 when every mutant errored", async () => {
    const mutants: Mutant[] = [
      { id: "missing-a", file: "index.js", find: "missing", replace: "x" },
      { id: "noop", file: "index.js", find: "a < b", replace: "a < b" },
    ];
    const result = await runMutationBattery(repoDir, testCmd, mutants, makeDeps({
      files: { [filePath]: original },
    }));

    expect(result.score).toBe(0);
    expect(result.errored).toEqual(["missing-a", "noop"]);
  });

  it("restores the file even when exec throws", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const mutants: Mutant[] = [
      { id: "throws", file: "index.js", find: "a < b", replace: "a <= b" },
    ];

    const result = await runMutationBattery(repoDir, testCmd, mutants, makeDeps({
      files: { [filePath]: original },
      onWrite: (path, content) => writes.push({ path, content }),
      exec: async () => {
        throw new Error("exec exploded");
      },
    }));

    expect(result.errored).toEqual(["throws"]);
    expect(writes).toEqual([
      { path: filePath, content: original.replace("a < b", "a <= b") },
      { path: filePath, content: original },
    ]);
  });

  it("computes score as killed / (killed + survived)", async () => {
    const mutants: Mutant[] = [
      { id: "k1", file: "index.js", find: "a < b", replace: "a <= b" },
      { id: "k2", file: "index.js", find: "b - a", replace: "b + a" },
      { id: "s1", file: "index.js", find: "a - b", replace: "a - b + 0" },
    ];
    let calls = 0;

    const result = await runMutationBattery(repoDir, testCmd, mutants, makeDeps({
      files: { [filePath]: original },
      exec: async () => {
        calls++;
        return calls <= 2 ? { code: 1, output: "fail" } : { code: 0, output: "" };
      },
    }));

    expect(result.killed).toEqual(["k1", "k2"]);
    expect(result.survived).toEqual(["s1"]);
    expect(result.score).toBeCloseTo(2 / 3);
  });
});

describe("certifyOracle", () => {
  const passingDet: DeterminismResult = {
    ok: true,
    runs: 20,
    greenRuns: 20,
    detail: "20/20 runs passed (exit 0)",
  };
  const failingDet: DeterminismResult = {
    ok: false,
    runs: 20,
    greenRuns: 3,
    detail: "run 4/20 failed",
  };
  const strongMut: MutationResult = {
    score: 0.8,
    killed: ["a", "b", "c", "d"],
    survived: ["e"],
    errored: [],
    detail: "score 0.8 (4 killed, 1 survived, 0 errored)",
  };
  const weakMut: MutationResult = {
    score: 0.5,
    killed: ["a"],
    survived: ["b"],
    errored: [],
    detail: "score 0.5 (1 killed, 1 survived, 0 errored)",
  };

  it("passes when determinism and mutation score meet the default threshold", () => {
    const result = certifyOracle(passingDet, strongMut);
    expect(result.ok).toBe(true);
    expect(result.gates.map((g) => g.name)).toEqual(["G0: determinism", "G2: mutation score"]);
    expect(result.gates.every((g) => g.ok)).toBe(true);
  });

  it("fails when determinism fails", () => {
    const result = certifyOracle(failingDet, strongMut);
    expect(result.ok).toBe(false);
    expect(result.gates[0]?.ok).toBe(false);
    expect(result.gates[1]?.ok).toBe(true);
  });

  it("fails when mutation score is below threshold", () => {
    const result = certifyOracle(passingDet, weakMut);
    expect(result.ok).toBe(false);
    expect(result.gates[0]?.ok).toBe(true);
    expect(result.gates[1]?.ok).toBe(false);
  });

  it("respects a custom minMutationScore", () => {
    const borderline: MutationResult = { ...strongMut, score: 0.7 };
    expect(certifyOracle(passingDet, borderline, { minMutationScore: 0.75 }).ok).toBe(false);
    expect(certifyOracle(passingDet, borderline, { minMutationScore: 0.7 }).ok).toBe(true);
  });
});
