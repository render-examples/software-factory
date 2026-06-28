#!/usr/bin/env node

/**
 * create-render-agent
 *
 * `npm create render-agent` scaffolder. Interactive wizard (or `--yes` for CI)
 * that emits a runnable, deployable code-review project in the spec layout.
 *
 * No `@render-agents/*` runtime dependencies — it only prompts + writes files.
 */

import { resolve } from "node:path";
import * as p from "@clack/prompts";
import type { PackageManager, Provider, ScaffoldOptions } from "./blueprint.js";
import { writeProject } from "./write.js";

export const SCAFFOLDER_VERSION = "0.0.1" as const;

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
    else if (a === "--pm") args.packageManager = argv[++i] as PackageManager;
    else if (a === "--provider") args.provider = argv[++i] as Provider;
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
  p.intro("create-render-agent");

  const name = args.name ?? (await p.text({
    message: "Project name",
    placeholder: "my-agents",
    defaultValue: "my-agents",
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
  const targetDir = resolve(process.cwd(), opts.name);

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

// Execute when run as a CLI (not when imported by tests).
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
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
