import * as crypto from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as render from "./render-api.js";
import * as github from "./github-api.js";
import * as llmApi from "./llm-api.js";
import { ask, askChoice, askYesNo, askSecret, closePrompt } from "./prompt.js";

interface InitOptions {
  slack?: boolean;
  github?: boolean;
  envOnly?: boolean;
}

interface CollectedEnv {
  RENDER_API_KEY?: string;
  RENDER_FACTORY_API_KEY?: string;
  RENDER_FACTORY_ENCRYPTION_KEY?: string;
  RENDER_WORKFLOW_SLUG?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GITHUB_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_BOT_LOGIN?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  [key: string]: string | undefined;
}

function step(n: number, total: number, label: string): void {
  console.log(`\n\x1b[1mStep ${n}/${total}: ${label}\x1b[0m`);
}

function pass(msg: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function warn(msg: string): void {
  console.log(`  \x1b[33m⚠\x1b[0m ${msg}`);
}

function fail(msg: string): void {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
}

export async function init(opts: InitOptions = {}): Promise<void> {
  console.log("\n\x1b[1mrender-factory setup\x1b[0m");
  console.log("====================");

  const env: CollectedEnv = {};
  const totalSteps = opts.slack ? 1 : opts.github ? 1 : 6;
  let currentStep = 0;

  try {
    if (opts.slack) {
      step(1, 1, "Slack");
      await collectSlack(env);
      await writeEnvFile(env);
      return;
    }

    if (opts.github) {
      step(1, 1, "GitHub");
      await collectGitHub(env);
      await writeEnvFile(env);
      return;
    }

    // Step 1: Render API key
    step(++currentStep, totalSteps, "Render API key");
    await collectRenderApiKey(env);

    // Step 2: Find services
    step(++currentStep, totalSteps, "Render services");
    const { gateway, workflows } = await findServices(env);

    // Step 3: Workflows service
    step(++currentStep, totalSteps, "Workflows service");
    await collectWorkflowsSlug(env, workflows);

    // Step 4: LLM provider
    step(++currentStep, totalSteps, "LLM provider");
    await collectLlmProvider(env);

    // Step 5: GitHub
    step(++currentStep, totalSteps, "GitHub");
    await collectGitHub(env, gateway);

    // Step 6: Slack (optional)
    step(++currentStep, totalSteps, "Slack (optional)");
    const wantSlack = await askYesNo("Set up Slack?");
    if (wantSlack) {
      await collectSlack(env);
    } else {
      pass("Skipped Slack — you can add it later with `render-factory init --slack`");
    }

    // Sync env vars to services
    if (!opts.envOnly && gateway && workflows) {
      await syncEnvVars(env, gateway, workflows);
    }

    await writeEnvFile(env);

    console.log("\n\x1b[32mDone!\x1b[0m Run `npx render-factory doctor` to verify everything is healthy.\n");
  } finally {
    closePrompt();
  }
}

async function collectRenderApiKey(env: CollectedEnv): Promise<void> {
  const existing = process.env.RENDER_API_KEY;
  if (existing) {
    try {
      const owners = await render.listOwners(existing);
      pass(`Authenticated as workspace "${owners[0]?.name ?? "unknown"}" (from RENDER_API_KEY env)`);
      env.RENDER_API_KEY = existing;
      return;
    } catch {
      warn("Existing RENDER_API_KEY is invalid, prompting for a new one");
    }
  }

  while (true) {
    const key = await askSecret("Enter your Render API key (https://dashboard.render.com/settings#api-keys):");
    if (!key) { fail("API key is required"); continue; }
    try {
      const owners = await render.listOwners(key);
      pass(`Authenticated as workspace "${owners[0]?.name ?? "unknown"}"`);
      env.RENDER_API_KEY = key;
      return;
    } catch {
      fail("Invalid API key — try again");
    }
  }
}

async function findServices(env: CollectedEnv): Promise<{
  gateway?: render.RenderService;
  workflows?: render.RenderService;
}> {
  const apiKey = env.RENDER_API_KEY!;
  const services = await render.listServices(apiKey);

  const gateway = services.find((s) => s.name === "render-factory-gateway" || s.slug === "render-factory-gateway");
  const workflows = services.find((s) =>
    s.name.includes("render-factory") && (s.name.includes("workflow") || s.slug.includes("workflow")),
  );

  if (gateway) {
    pass(`Gateway found: ${gateway.name}`);
    if (gateway.serviceDetails?.url) {
      console.log(`  Gateway URL: https://${gateway.serviceDetails.url}`);
    }
  } else {
    warn("Gateway not found — deploy the Blueprint from render.yaml first");
    console.log("  1. Go to https://dashboard.render.com/select-repo?type=blueprint");
    console.log("  2. Select this repository");
    console.log("  3. Render will create the gateway, database, and cron services");
  }

  if (workflows) {
    pass(`Workflows service found: ${workflows.name}`);
  }

  return { gateway, workflows };
}

async function collectWorkflowsSlug(env: CollectedEnv, existing?: render.RenderService): Promise<void> {
  if (existing) {
    env.RENDER_WORKFLOW_SLUG = existing.slug || existing.name;
    pass(`Workflow slug: ${env.RENDER_WORKFLOW_SLUG}`);
    return;
  }

  warn("Blueprints can't create Workflows services yet.");
  console.log();
  console.log("  Create one manually in the Render Dashboard:");
  console.log("    1. Go to https://dashboard.render.com/create?type=workflows");
  console.log("    2. Connect this repository");
  console.log("    3. Set the start command to: pnpm --filter @render-factory/app workflows");
  console.log("    4. Choose the \"standard\" plan");
  console.log();

  while (true) {
    const slug = await ask("Enter the Workflows service slug (e.g. render-factory-workflows):");
    if (!slug) { fail("Workflow slug is required"); continue; }

    try {
      const services = await render.listServices(env.RENDER_API_KEY!);
      const found = services.find((s) => s.slug === slug || s.name === slug);
      if (found) {
        pass(`Found service "${found.name}"`);
        env.RENDER_WORKFLOW_SLUG = slug;
        return;
      }
      warn(`No service found with slug "${slug}" — it may not be deployed yet. Continuing with this slug.`);
      env.RENDER_WORKFLOW_SLUG = slug;
      return;
    } catch {
      env.RENDER_WORKFLOW_SLUG = slug;
      return;
    }
  }
}

async function collectLlmProvider(env: CollectedEnv): Promise<void> {
  const provider = await askChoice("Which provider?", ["anthropic", "openai"]);

  if (provider === "anthropic") {
    while (true) {
      const key = await askSecret("Enter your Anthropic API key:");
      if (!key) { fail("API key is required"); continue; }
      const valid = await llmApi.validateAnthropicKey(key);
      if (valid) {
        pass("API key validated");
        env.ANTHROPIC_API_KEY = key;
        return;
      }
      fail("Key validation failed — try again");
    }
  } else {
    while (true) {
      const key = await askSecret("Enter your OpenAI API key:");
      if (!key) { fail("API key is required"); continue; }
      const valid = await llmApi.validateOpenAIKey(key);
      if (valid) {
        pass("API key validated");
        env.OPENAI_API_KEY = key;
        return;
      }
      fail("Key validation failed — try again");
    }
  }
}

async function collectGitHub(
  env: CollectedEnv,
  gateway?: render.RenderService,
): Promise<void> {
  while (true) {
    const token = await askSecret("Enter a fine-grained GitHub PAT (Contents, PRs, Issues — read/write):");
    if (!token) { fail("Token is required"); continue; }
    const validation = await github.validateToken(token);
    if (!validation.valid) {
      fail("Token is invalid — try again");
      continue;
    }
    const writeRepos = validation.repos!.filter((r) => r.permissions?.push);
    pass(`Token has access to ${writeRepos.length} repositories`);
    env.GITHUB_TOKEN = token;
    env.GITHUB_BOT_LOGIN = validation.user!.login;
    pass(`Bot login set to "${env.GITHUB_BOT_LOGIN}"`);
    break;
  }

  const existingSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (existingSecret) {
    env.GITHUB_WEBHOOK_SECRET = existingSecret;
    pass("Using existing GITHUB_WEBHOOK_SECRET");
  } else {
    const customSecret = await ask("Enter a webhook secret (or press Enter to generate one):");
    env.GITHUB_WEBHOOK_SECRET = customSecret || crypto.randomBytes(32).toString("hex");
    pass(customSecret ? "Webhook secret set" : "Generated webhook secret");
  }

  const gatewayUrl = gateway?.serviceDetails?.url
    ? `https://${gateway.serviceDetails.url}`
    : "<your-gateway-url>";

  console.log();
  console.log("  Add a webhook to each repo you want the factory to operate on:");
  console.log(`    URL:    ${gatewayUrl}/channels/github`);
  console.log(`    Secret: ${env.GITHUB_WEBHOOK_SECRET}`);
  console.log("    Events: Issues, Issue comments, Pull requests, Pull request reviews");
}

async function collectSlack(env: CollectedEnv): Promise<void> {
  const botToken = await askSecret("Enter your Slack Bot Token (xoxb-...):");
  if (botToken) {
    env.SLACK_BOT_TOKEN = botToken;
    pass("SLACK_BOT_TOKEN set");
  }

  const signingSecret = await askSecret("Enter your Slack Signing Secret:");
  if (signingSecret) {
    env.SLACK_SIGNING_SECRET = signingSecret;
    pass("SLACK_SIGNING_SECRET set");
  }
}

async function syncEnvVars(
  env: CollectedEnv,
  gateway: render.RenderService,
  workflows: render.RenderService,
): Promise<void> {
  const apiKey = env.RENDER_API_KEY!;

  const varsToSync: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(env)) {
    if (key === "RENDER_API_KEY" || !value) continue;
    varsToSync.push({ key, value });
  }

  if (varsToSync.length === 0) return;

  console.log("\nSetting environment variables on gateway...");
  try {
    const existing = await render.getEnvVars(apiKey, gateway.id);
    const merged = mergeEnvVars(existing, varsToSync);
    await render.updateEnvVars(apiKey, gateway.id, merged);
    for (const v of varsToSync) pass(v.key);
  } catch (e) {
    fail(`Failed to set gateway env vars: ${e}`);
  }

  console.log("\nSetting environment variables on workflows service...");
  try {
    const existing = await render.getEnvVars(apiKey, workflows.id);
    const merged = mergeEnvVars(existing, varsToSync);
    await render.updateEnvVars(apiKey, workflows.id, merged);
    pass(`${varsToSync.length} variables synced`);
  } catch (e) {
    fail(`Failed to set workflows env vars: ${e}`);
  }
}

function mergeEnvVars(
  existing: render.RenderEnvVar[],
  updates: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> {
  const merged = existing.map((v) => ({ key: v.key, value: v.value }));
  for (const update of updates) {
    const idx = merged.findIndex((v) => v.key === update.key);
    if (idx >= 0) merged[idx] = update;
    else merged.push(update);
  }
  return merged;
}

async function writeEnvFile(env: CollectedEnv): Promise<void> {
  const lines: string[] = [
    "# Generated by `render-factory init`",
    "",
  ];

  const orderedKeys = [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
    "RENDER_FACTORY_API_KEY", "RENDER_FACTORY_ENCRYPTION_KEY",
    "RENDER_API_KEY", "RENDER_WORKFLOW_SLUG",
    "GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "GITHUB_BOT_LOGIN",
    "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET",
  ];

  for (const key of orderedKeys) {
    const value = env[key];
    if (value) lines.push(`${key}=${value}`);
  }

  const path = join(process.cwd(), ".env");
  await writeFile(path, lines.join("\n") + "\n");
  console.log(`\nWrote .env to ${path}`);
}
