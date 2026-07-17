import { workflow } from "@render-agents/sdk";
import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runShell, workspaceRoot } from "../../src/lib/workspace.js";
import { runParityCheck, type ParityResult } from "../../src/lib/parity.js";

// Native JS→TS migration spike (M0.5). Clones a repo into the workspace root,
// runs the `migrator` agent (render-agents' native engine + the `workspace`
// filesystem/exec tools — the same self-correction loop as `implementer`), then
// verifies with the parity oracle. No opencode: the agent gets compiler feedback
// by running `tsc`/tests via `workspace__exec` and reading non-zero exits.

const DEFAULT_REPO_URL = "https://github.com/sindresorhus/leven";
const CLONE_TIMEOUT_MS = 120_000;

interface LevenMigrateInput {
  repoUrl?: string;
}

interface MigrateResult {
  repoDir: string;
  migrated: { text: string } | { skipped: true; reason: string };
  parity: ParityResult;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const emptyParity: ParityResult = { ok: false, output: "", gates: [] };

export default workflow({ name: "leven-migrate" }, async (ctx): Promise<MigrateResult> => {
  const input = typeof ctx.input === "object" && ctx.input !== null ? (ctx.input as LevenMigrateInput) : {};
  const repoUrl = typeof input.repoUrl === "string" && input.repoUrl.trim() ? input.repoUrl : DEFAULT_REPO_URL;
  const repoDir = join(workspaceRoot(), "leven-migrate");

  // Fresh, deterministic checkout each run. Not wrapped in ctx.step: the clone is
  // a real side effect on the container's local FS that a memoized step couldn't
  // reproduce on a fresh container (see src/lib/workspace.ts).
  const root = workspaceRoot();
  await mkdir(root, { recursive: true });
  await rm(repoDir, { recursive: true, force: true });
  const clone = await runShell(`git clone --depth 1 ${JSON.stringify(repoUrl)} ${JSON.stringify(repoDir)}`, {
    cwd: root,
    timeoutMs: CLONE_TIMEOUT_MS,
  });
  if (clone.code !== 0) {
    return {
      repoDir,
      migrated: { skipped: true, reason: `git clone failed: ${clone.stderr.trim() || clone.stdout.trim()}` },
      parity: emptyParity,
    };
  }

  const migrator = await ctx.agents.get("migrator").run(
    `repoDir: ${repoDir}\n\n` +
      "Port this repository from JavaScript to TypeScript, preserving exact runtime behavior. " +
      "Convert index.js to index.ts, add a tsconfig.json, install any dev deps you need, and " +
      "iterate with `workspace__exec` (cwd: the repoDir) until `npx tsc --noEmit` and the existing " +
      "behavior tests (`npx ava`) pass.",
  );

  const parity = await ctx.step("parity", () =>
    runParityCheck(
      repoDir,
      {
        exists,
        exec: async (cmd, cwd) => {
          const r = await runShell(cmd, { cwd, timeoutMs: 600_000 });
          return { code: r.code, output: [r.stdout, r.stderr].filter((s) => s.trim()).join("\n").trim() };
        },
      },
      // Behavior parity = the characterization tests (ava), NOT `npm test`, which
      // for leven is `xo && ava` — xo is lint (not behavior) and its legacy
      // eslint stack crashes under Node 24 (`util.isDate is not a function`).
      { testCommand: "npx ava" },
    ),
  );

  return { repoDir, migrated: { text: migrator.text }, parity };
});
