import { describe, expect, it } from "vitest";
import { runParityCheck, type ParityDeps } from "../src/lib/parity.js";

function deps(overrides: {
  present?: string[];
  exec?: (cmd: string) => { code: number; output: string };
}): ParityDeps {
  const present = new Set((overrides.present ?? []).map((p) => p));
  return {
    exists: async (p: string) => [...present].some((suffix) => p.endsWith(suffix)),
    exec: async (cmd: string) => (overrides.exec ? overrides.exec(cmd) : { code: 0, output: "" }),
  };
}

describe("runParityCheck", () => {
  it("fails fast when index.ts is absent (no false positive on an unmigrated clone)", async () => {
    const result = await runParityCheck("/repo", deps({ present: ["node_modules", "tsconfig.json"] }));
    expect(result.ok).toBe(false);
    expect(result.gates).toHaveLength(1);
    expect(result.gates[0]?.name).toContain("artifact");
    // npm test must never run when migration didn't happen.
    expect(result.output).not.toContain("npm test");
  });

  it("passes only when all four gates pass", async () => {
    const result = await runParityCheck(
      "/repo",
      deps({ present: ["index.ts", "node_modules", "tsconfig.json"], exec: () => ({ code: 0, output: "ok" }) }),
    );
    expect(result.ok).toBe(true);
    expect(result.gates.map((g) => g.name)).toEqual([
      "artifact: index.ts exists",
      "deps: node_modules present",
      "typecheck: npx tsc --noEmit",
      "behavior: npm test",
    ]);
  });

  it("stops at the typecheck gate when tsc fails and never runs the tests", async () => {
    const result = await runParityCheck(
      "/repo",
      deps({
        present: ["index.ts", "node_modules", "tsconfig.json"],
        exec: (cmd) => (cmd.includes("tsc") ? { code: 2, output: "TS error" } : { code: 0, output: "" }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.gates.at(-1)?.name).toContain("tsc");
    expect(result.output).not.toContain("npm test");
  });

  it("fails when a TS migration produced no tsconfig.json", async () => {
    const result = await runParityCheck("/repo", deps({ present: ["index.ts", "node_modules"] }));
    expect(result.ok).toBe(false);
    expect(result.gates.at(-1)?.name).toContain("tsconfig.json exists");
  });
});
