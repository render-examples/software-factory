#!/usr/bin/env node

/**
 * create-render-agents
 *
 * `npm create render-agents` scaffolder. Interactive wizard (or `--yes` for CI)
 * that emits a runnable, deployable code-review project in the spec layout.
 *
 * No `@render-agents/*` runtime dependencies — it only prompts + writes files.
 */

import { resolve, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as p from "@clack/prompts";
import type { PackageManager, Provider, ScaffoldOptions } from "./blueprint.js";
import { writeProject } from "./write.js";

export const SCAFFOLDER_VERSION = "0.0.1" as const;

const PACKAGE_MANAGERS: PackageManager[] = ["pnpm", "npm", "yarn"];
const PROVIDERS: Provider[] = ["anthropic", "openai"];

/**
 * Validate a project name. It becomes a folder under cwd and the package.json
 * `name`, so it must be a plain, single-segment directory name — no path
 * separators, `..`, or absolute paths (prevents writing outside cwd, CR-27).
 */
export function validateProjectName(raw: string): string | undefined {
  const name = (raw ?? "").trim();
  if (!name) return "Project name is required";
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    return "Project name must be a plain folder name (no path separators)";
  }
  if (name.includes("..")) return "Project name must not contain '..'";
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    return "Project name must start with a letter/digit and use only letters, digits, '.', '_', '-'";
  }
  return undefined;
}

export { buildFileMap } from "./blueprint.js";
export type { ScaffoldOptions, PackageManager, Provider } from "./blueprint.js";
export { writeProject } from "./write.js";

const PROVIDER_KEY_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

interface CliArgs {
  name?: string;
  yes: boolean;
  force: boolean;
  packageManager?: PackageManager;
  provider?: Provider;
  postgres?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { yes: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--force") args.force = true;
    else if (a === "--pm") {
      const v = argv[++i];
      if (!v || !PACKAGE_MANAGERS.includes(v as PackageManager)) {
        throw new Error(`--pm requires one of: ${PACKAGE_MANAGERS.join(", ")}`);
      }
      args.packageManager = v as PackageManager;
    }
    else if (a === "--provider") {
      const v = argv[++i];
      if (!v || !PROVIDERS.includes(v as Provider)) {
        throw new Error(`--provider requires one of: ${PROVIDERS.join(", ")}`);
      }
      args.provider = v as Provider;
    }
    else if (a === "--postgres") args.postgres = true;
    else if (a === "--no-postgres") args.postgres = false;
    else if (!a.startsWith("-") && !args.name) args.name = a;
  }
  return args;
}

/** Resolve options from CLI flags, falling back to defaults (used by `--yes`). */
export function optionsFromArgs(args: CliArgs): ScaffoldOptions {
  const provider = args.provider ?? "anthropic";
  return {
    name: args.name ?? "my-agents",
    packageManager: args.packageManager ?? "pnpm",
    provider,
    apiKeyEnv: PROVIDER_KEY_ENV[provider],
    withPostgres: args.postgres ?? false,
  };
}

async function runWizard(args: CliArgs): Promise<ScaffoldOptions> {
  p.intro("create-render-agents");

  const name = args.name ?? (await p.text({
    message: "Project name",
    placeholder: "my-agents",
    defaultValue: "my-agents",
    validate: (v) => validateProjectName(v || "my-agents"),
  })) as string;

  const pmOptions: Array<{ value: PackageManager; label: string }> = [
    { value: "pnpm", label: "pnpm" },
    { value: "npm", label: "npm" },
    { value: "yarn", label: "yarn" },
  ];
  const packageManager = (args.packageManager ?? (await p.select({
    message: "Package manager",
    options: pmOptions,
    initialValue: "pnpm" as PackageManager,
  }))) as PackageManager;

  const providerOptions: Array<{ value: Provider; label: string }> = [
    { value: "anthropic", label: "Anthropic (Claude)" },
    { value: "openai", label: "OpenAI" },
  ];
  const provider = (args.provider ?? (await p.select({
    message: "Model provider",
    options: providerOptions,
    initialValue: "anthropic" as Provider,
  }))) as Provider;

  const withPostgres = args.postgres ?? (await p.confirm({
    message: "Include local Postgres (compose.yaml) for the durable path?",
    initialValue: true,
  })) as boolean;

  p.outro("Scaffolding…");
  return { name, packageManager, provider, apiKeyEnv: PROVIDER_KEY_ENV[provider], withPostgres };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const opts = args.yes ? optionsFromArgs(args) : await runWizard(args);

  // Validate the name and confine the target to cwd — an unvalidated name like
  // `../../x` or an absolute path would otherwise escape the intended parent (CR-27).
  const nameError = validateProjectName(opts.name);
  if (nameError) throw new Error(nameError);
  const cwd = resolve(process.cwd());
  const targetDir = resolve(cwd, opts.name);
  if (targetDir !== cwd && !targetDir.startsWith(cwd + sep)) {
    throw new Error(`Refusing to scaffold outside the current directory: ${targetDir}`);
  }

  const result = await writeProject(targetDir, opts, args.force);

  const run = opts.packageManager === "npm" ? "npm run" : opts.packageManager;
  const install = opts.packageManager === "npm" ? "npm install" : `${opts.packageManager} install`;
  console.log(`\n✔ Created ${result.files.length} files in ${targetDir}\n`);
  console.log("Next steps:");
  console.log(`  cd ${opts.name}`);
  console.log(`  ${install}`);
  console.log(`  cp .env.example .env   # add your ${opts.apiKeyEnv}`);
  console.log(`  ${run} dev\n`);
}

// Execute when run as a CLI (not when imported by tests). Use pathToFileURL so
// paths with spaces / Windows drive letters compare correctly (CR-30).
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
