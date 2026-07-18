import { workflow } from "@render-agents/sdk";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runShell, workspaceRoot } from "../../src/lib/workspace.js";
import {
  certifyOracle,
  runDeterminismCheck,
  runMutationBattery,
  type DeterminismResult,
  type MutationResult,
  type OracleCertification,
  type OracleExecDeps,
} from "../../src/lib/oracle.js";
import { levenMutants } from "./leven-mutants.js";

const DEFAULT_REPO_URL = "https://github.com/sindresorhus/leven";
const CLONE_TIMEOUT_MS = 120_000;
const ORACLE_FILE = "__characterization__.test.mjs";
const ORACLE_COMMAND = `node --test ${ORACLE_FILE}`;

interface CharacterizeInput {
  repoUrl?: string;
  determinismRuns?: number;
  minMutationScore?: number;
}

interface Skipped {
  skipped: true;
  reason: string;
}

interface CharacterizeResult {
  repoDir: string;
  oracleFile: typeof ORACLE_FILE;
  oracleCommand: typeof ORACLE_COMMAND;
  generated: { text: string } | Skipped;
  determinism: DeterminismResult | Skipped;
  mutation: MutationResult | Skipped;
  certification: OracleCertification | Skipped;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function skip(reason: string): Skipped {
  return { skipped: true, reason };
}

function buildOracleDeps(): OracleExecDeps {
  return {
    exec: async (cmd, cwd) => {
      const r = await runShell(cmd, { cwd, timeoutMs: 600_000 });
      return {
        code: r.code,
        output: [r.stdout, r.stderr].filter((s) => s.trim()).join("\n").trim(),
      };
    },
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, content) => writeFile(path, content, "utf8"),
  };
}

/** True when only the oracle test file was added/changed (source must stay pristine). */
async function unexpectedSourceChanges(repoDir: string): Promise<string | null> {
  const status = await runShell("git status --porcelain", { cwd: repoDir, timeoutMs: 30_000 });
  if (status.code !== 0) {
    return `git status failed: ${[status.stderr, status.stdout].filter((s) => s.trim()).join("\n").trim()}`;
  }

  const lines = status.stdout.trim().split("\n").filter(Boolean);
  const unexpected = lines
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== ORACLE_FILE);

  if (unexpected.length === 0) return null;
  return `source files modified by agent (expected only ${ORACLE_FILE}): ${unexpected.join(", ")}`;
}

export default workflow({ name: "characterize" }, async (ctx): Promise<CharacterizeResult> => {
  const input = typeof ctx.input === "object" && ctx.input !== null ? (ctx.input as CharacterizeInput) : {};
  const repoUrl = typeof input.repoUrl === "string" && input.repoUrl.trim() ? input.repoUrl : DEFAULT_REPO_URL;
  const determinismRuns =
    typeof input.determinismRuns === "number" && input.determinismRuns > 0 ? input.determinismRuns : 20;
  const minMutationScore =
    typeof input.minMutationScore === "number" && input.minMutationScore >= 0 ? input.minMutationScore : 0.75;

  const repoDir = join(workspaceRoot(), "characterize");

  // Fresh, deterministic checkout each run (same pattern as leven-migrate).
  const root = workspaceRoot();
  await mkdir(root, { recursive: true });
  await rm(repoDir, { recursive: true, force: true });
  const clone = await runShell(`git clone --depth 1 ${JSON.stringify(repoUrl)} ${JSON.stringify(repoDir)}`, {
    cwd: root,
    timeoutMs: CLONE_TIMEOUT_MS,
  });
  if (clone.code !== 0) {
    const reason = `git clone failed: ${clone.stderr.trim() || clone.stdout.trim()}`;
    return {
      repoDir,
      oracleFile: ORACLE_FILE,
      oracleCommand: ORACLE_COMMAND,
      generated: skip(reason),
      determinism: skip(reason),
      mutation: skip(reason),
      certification: skip(reason),
    };
  }

  const characterizer = await ctx.agents.get("characterizer").run(
    `repoDir: ${repoDir}\n\n` +
      `Generate a deterministic characterization / golden-master test for this repository's public API. ` +
      `Write it to ${ORACLE_FILE} at the repo root. It must pass with: ${ORACLE_COMMAND}. ` +
      "Read the source first; do not modify any source files — only create the oracle test file.",
  );

  const oraclePath = join(repoDir, ORACLE_FILE);
  if (!(await exists(oraclePath))) {
    const reason = `oracle file missing: ${ORACLE_FILE} was not created by the characterizer agent`;
    return {
      repoDir,
      oracleFile: ORACLE_FILE,
      oracleCommand: ORACLE_COMMAND,
      generated: { text: characterizer.text },
      determinism: skip(reason),
      mutation: skip(reason),
      certification: skip(reason),
    };
  }

  const sourceChange = await unexpectedSourceChanges(repoDir);
  if (sourceChange) {
    return {
      repoDir,
      oracleFile: ORACLE_FILE,
      oracleCommand: ORACLE_COMMAND,
      generated: { text: characterizer.text },
      determinism: skip(sourceChange),
      mutation: skip(sourceChange),
      certification: skip(sourceChange),
    };
  }

  const deps = buildOracleDeps();

  const { determinism, mutation, certification } = await ctx.step("certify", async () => {
    const determinism = await runDeterminismCheck(ORACLE_COMMAND, repoDir, deps, {
      runs: determinismRuns,
    });
    const mutation = await runMutationBattery(repoDir, ORACLE_COMMAND, levenMutants, deps);
    const certification = certifyOracle(determinism, mutation, { minMutationScore });
    return { determinism, mutation, certification };
  });

  return {
    repoDir,
    oracleFile: ORACLE_FILE,
    oracleCommand: ORACLE_COMMAND,
    generated: { text: characterizer.text },
    determinism,
    mutation,
    certification,
  };
});
