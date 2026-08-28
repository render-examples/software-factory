#!/usr/bin/env node

import { doctor } from "./doctor.js";
import { init } from "./init.js";

const args = process.argv.slice(2);
const command = args[0];

const flags = new Set(args.slice(1));
const hasFlag = (f: string): boolean => flags.has(f) || flags.has(`--${f}`);

async function main(): Promise<void> {
  switch (command) {
    case "init": {
      await init({
        slack: hasFlag("slack"),
        github: hasFlag("github"),
        envOnly: hasFlag("env-only"),
      });
      break;
    }

    case "doctor": {
      const ok = await doctor({
        json: hasFlag("json"),
        fix: hasFlag("fix"),
        local: hasFlag("local"),
      });
      process.exitCode = ok ? 0 : 1;
      break;
    }

    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`
\x1b[1mrender-factory\x1b[0m — CLI for setting up and managing your software factory

\x1b[1mCommands:\x1b[0m
  init      Guided interactive setup for deploying the factory
  doctor    Check all prerequisites and report health status

\x1b[1mrender-factory init\x1b[0m
  --slack       Run only the Slack setup step
  --github      Run only the GitHub setup step
  --env-only    Skip service creation; just collect credentials and write .env

\x1b[1mrender-factory doctor\x1b[0m
  --json        Output structured JSON instead of human-readable text
  --fix         Attempt to fix issues (e.g., sync missing env vars)
  --local       Check local dev prerequisites instead of production
`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
