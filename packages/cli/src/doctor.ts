import * as render from "./render-api.js";
import * as github from "./github-api.js";
import * as llm from "./llm-api.js";
import type { CheckResult } from "./output.js";
import { printResults } from "./output.js";

interface DoctorOptions {
  json?: boolean;
  fix?: boolean;
  local?: boolean;
}

export async function doctor(opts: DoctorOptions = {}): Promise<boolean> {
  if (opts.local) {
    return doctorLocal(opts);
  }

  console.log("\n\x1b[1mrender-factory health check\x1b[0m");
  console.log("===========================\n");

  const results: CheckResult[] = [];

  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) {
    results.push({ category: "Render platform", label: "RENDER_API_KEY is set", status: "fail", fix: "Set RENDER_API_KEY in your environment or .env file" });
    printResults(results, !!opts.json);
    return false;
  }

  let owners: render.RenderOwner[] = [];
  try {
    owners = await render.listOwners(apiKey);
    const name = owners[0]?.name ?? "unknown";
    results.push({ category: "Render platform", label: "RENDER_API_KEY is valid", status: "pass", detail: `workspace: ${name}` });
  } catch (e) {
    results.push({ category: "Render platform", label: "RENDER_API_KEY is valid", status: "fail", detail: String(e), fix: "Check your API key at https://dashboard.render.com/settings#api-keys" });
    printResults(results, !!opts.json);
    return false;
  }

  const [gatewayCheck, workflowsCheck, dbCheck] = await Promise.all([
    checkService(apiKey, "render-factory-gateway", "Render platform", results),
    checkService(apiKey, "render-factory-workflows", "Render platform", results),
    checkPostgres(apiKey, "render-factory-db", results),
  ]);

  if (gatewayCheck?.serviceDetails?.url) {
    const health = await render.checkHealth(`https://${gatewayCheck.serviceDetails.url}`);
    results.push({
      category: "Render platform",
      label: `Gateway health check: https://${gatewayCheck.serviceDetails.url}/health`,
      status: health.ok ? "pass" : "fail",
      detail: health.ok ? `${health.status}` : `status ${health.status}`,
      fix: health.ok ? undefined : "Check gateway logs for errors",
    });
  }

  if (gatewayCheck) {
    await checkEnvVars(apiKey, gatewayCheck.id, "gateway", results);
  }
  if (workflowsCheck && gatewayCheck) {
    await checkEnvVarSync(apiKey, gatewayCheck.id, workflowsCheck.id, results, !!opts.fix);
  }

  await checkLlmProvider(results);
  await checkGitHub(gatewayCheck, results);
  checkSlack(results);

  if (gatewayCheck) await checkDeploys(apiKey, gatewayCheck.id, "Gateway", results);
  if (workflowsCheck) await checkDeploys(apiKey, workflowsCheck.id, "Workflows", results);

  printResults(results, !!opts.json);
  return results.every((r) => r.status !== "fail");
}

async function checkService(
  apiKey: string,
  name: string,
  category: string,
  results: CheckResult[],
): Promise<render.RenderService | undefined> {
  try {
    const services = await render.listServices(apiKey, name);
    const svc = services.find((s) => s.name === name || s.slug === name);
    if (svc) {
      const suspended = svc.suspended === "suspended";
      results.push({
        category,
        label: `${name} service found`,
        status: suspended ? "warn" : "pass",
        detail: suspended ? "suspended" : "running",
        fix: suspended ? `Resume ${name} in the Render Dashboard` : undefined,
      });
      return svc;
    }
    results.push({ category, label: `${name} service found`, status: "fail", fix: `Create the ${name} service in the Render Dashboard` });
  } catch (e) {
    results.push({ category, label: `${name} service found`, status: "fail", detail: String(e) });
  }
  return undefined;
}

async function checkPostgres(
  apiKey: string,
  name: string,
  results: CheckResult[],
): Promise<void> {
  try {
    const dbs = await render.listPostgres(apiKey, name);
    const db = dbs.find((d) => d.name === name);
    if (db) {
      results.push({ category: "Render platform", label: `Database: ${name}`, status: db.status === "available" ? "pass" : "warn", detail: db.status });
    } else {
      results.push({ category: "Render platform", label: `Database: ${name}`, status: "fail", fix: "Deploy the Blueprint from render.yaml to create the database" });
    }
  } catch (e) {
    results.push({ category: "Render platform", label: `Database: ${name}`, status: "fail", detail: String(e) });
  }
}

const REQUIRED_GATEWAY_VARS = [
  "DATABASE_URL",
  "RENDER_FACTORY_API_KEY",
  "RENDER_FACTORY_ENCRYPTION_KEY",
  "RENDER_WORKFLOW_SLUG",
  "GITHUB_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_BOT_LOGIN",
];

const SHARED_VARS = [
  "DATABASE_URL",
  "GITHUB_TOKEN",
  "RENDER_WORKFLOW_SLUG",
];

async function checkEnvVars(
  apiKey: string,
  serviceId: string,
  label: string,
  results: CheckResult[],
): Promise<Map<string, string>> {
  const category = `Environment variables (${label})`;
  const vars = new Map<string, string>();
  try {
    const envVars = await render.getEnvVars(apiKey, serviceId);
    for (const v of envVars) vars.set(v.key, v.value);

    const required = label === "gateway" ? REQUIRED_GATEWAY_VARS : SHARED_VARS;
    for (const key of required) {
      const hasProvider = vars.has("ANTHROPIC_API_KEY") || vars.has("OPENAI_API_KEY");
      if (key === "ANTHROPIC_API_KEY" || key === "OPENAI_API_KEY") continue;
      if (vars.has(key)) {
        const detail = key === "RENDER_WORKFLOW_SLUG" ? `= ${vars.get(key)}` : undefined;
        results.push({ category, label: key, status: "pass", detail });
      } else {
        results.push({ category, label: key, status: "fail", fix: `Set ${key} on the ${label} service` });
      }
    }
    if (label === "gateway") {
      const hasProvider = vars.has("ANTHROPIC_API_KEY") || vars.has("OPENAI_API_KEY");
      results.push({
        category,
        label: "LLM provider key (ANTHROPIC_API_KEY or OPENAI_API_KEY)",
        status: hasProvider ? "pass" : "fail",
        fix: hasProvider ? undefined : "Set ANTHROPIC_API_KEY or OPENAI_API_KEY",
      });
    }
  } catch (e) {
    results.push({ category, label: `Fetch env vars for ${label}`, status: "fail", detail: String(e) });
  }
  return vars;
}

async function checkEnvVarSync(
  apiKey: string,
  gatewayId: string,
  workflowsId: string,
  results: CheckResult[],
  fix: boolean,
): Promise<void> {
  const category = "Environment variables (workflows)";
  try {
    const [gwVars, wfVars] = await Promise.all([
      render.getEnvVars(apiKey, gatewayId),
      render.getEnvVars(apiKey, workflowsId),
    ]);
    const gwMap = new Map(gwVars.map((v) => [v.key, v.value]));
    const wfMap = new Map(wfVars.map((v) => [v.key, v.value]));

    const missingOnWorkflows: Array<{ key: string; value: string }> = [];

    for (const key of SHARED_VARS) {
      const gwVal = gwMap.get(key);
      const wfVal = wfMap.get(key);
      if (gwVal && wfVal && gwVal === wfVal) {
        results.push({ category, label: `${key} (matches gateway)`, status: "pass" });
      } else if (gwVal && !wfVal) {
        results.push({ category, label: `${key} (missing on workflows)`, status: "fail", fix: fix ? "Fixing..." : `Copy ${key} from gateway to workflows service` });
        missingOnWorkflows.push({ key, value: gwVal });
      } else if (gwVal && wfVal && gwVal !== wfVal) {
        results.push({ category, label: `${key} (mismatch between gateway and workflows)`, status: "warn", fix: "Ensure both services use the same value" });
      } else {
        results.push({ category, label: `${key}`, status: "skip", detail: "not set on gateway" });
      }
    }

    const providerKey = gwMap.has("ANTHROPIC_API_KEY") ? "ANTHROPIC_API_KEY" : gwMap.has("OPENAI_API_KEY") ? "OPENAI_API_KEY" : null;
    if (providerKey) {
      const gwVal = gwMap.get(providerKey)!;
      const wfVal = wfMap.get(providerKey);
      if (wfVal === gwVal) {
        results.push({ category, label: `${providerKey} (matches gateway)`, status: "pass" });
      } else {
        results.push({ category, label: `${providerKey} (missing or mismatched on workflows)`, status: "fail", fix: fix ? "Fixing..." : `Copy ${providerKey} from gateway to workflows service` });
        missingOnWorkflows.push({ key: providerKey, value: gwVal });
      }
    }

    if (fix && missingOnWorkflows.length > 0) {
      const existing = wfVars.map((v) => ({ key: v.key, value: v.value }));
      const merged = [...existing];
      for (const missing of missingOnWorkflows) {
        const idx = merged.findIndex((v) => v.key === missing.key);
        if (idx >= 0) merged[idx] = missing;
        else merged.push(missing);
      }
      await render.updateEnvVars(apiKey, workflowsId, merged);
      results.push({ category, label: `Synced ${missingOnWorkflows.length} variable(s) to workflows`, status: "pass" });
    }
  } catch (e) {
    results.push({ category, label: "Env var sync check", status: "fail", detail: String(e) });
  }
}

async function checkLlmProvider(results: CheckResult[]): Promise<void> {
  const category = "LLM provider";
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (anthropicKey) {
    const valid = await llm.validateAnthropicKey(anthropicKey);
    results.push({ category, label: "Anthropic API key valid", status: valid ? "pass" : "fail", fix: valid ? undefined : "Check ANTHROPIC_API_KEY" });
  } else if (openaiKey) {
    const valid = await llm.validateOpenAIKey(openaiKey);
    results.push({ category, label: "OpenAI API key valid", status: valid ? "pass" : "fail", fix: valid ? undefined : "Check OPENAI_API_KEY" });
  } else {
    results.push({ category, label: "LLM provider key in local env", status: "skip", detail: "Set ANTHROPIC_API_KEY or OPENAI_API_KEY locally to validate" });
  }
}

async function checkGitHub(
  gateway: render.RenderService | undefined,
  results: CheckResult[],
): Promise<void> {
  const category = "GitHub";
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    results.push({ category, label: "GITHUB_TOKEN set locally", status: "skip", detail: "Set GITHUB_TOKEN locally to validate" });
    return;
  }

  const validation = await github.validateToken(token);
  if (!validation.valid) {
    results.push({ category, label: "Token authenticates", status: "fail", fix: "Check GITHUB_TOKEN — it may be expired or invalid" });
    return;
  }

  results.push({ category, label: `Token authenticated as "${validation.user!.login}"`, status: "pass" });

  const repos = validation.repos!;
  const writeRepos = repos.filter((r) => r.permissions?.push);
  if (writeRepos.length > 0) {
    const names = writeRepos.slice(0, 5).map((r) => r.full_name).join(", ");
    const suffix = writeRepos.length > 5 ? ` (+${writeRepos.length - 5} more)` : "";
    results.push({ category, label: `Token has write access to: ${names}${suffix}`, status: "pass" });
  } else {
    results.push({ category, label: "Token has write access to repos", status: "warn", detail: "no repos with push access found" });
  }

  const gatewayUrl = gateway?.serviceDetails?.url
    ? `https://${gateway.serviceDetails.url}`
    : undefined;

  if (gatewayUrl) {
    for (const repo of writeRepos.slice(0, 5)) {
      const [owner, name] = repo.full_name.split("/");
      const hooks = await github.listHooks(token, owner, name);
      const webhookUrl = `${gatewayUrl}/channels/github`;
      const found = hooks.some((h) => h.config.url === webhookUrl && h.active);
      if (found) {
        results.push({ category, label: `Webhook on ${repo.full_name}`, status: "pass" });
      } else {
        results.push({
          category,
          label: `Webhook on ${repo.full_name}`,
          status: "fail",
          fix: `Add webhook: URL ${webhookUrl}, Events: issues, issue_comment, pull_request, pull_request_review`,
        });
      }
    }
  }
}

function checkSlack(results: CheckResult[]): void {
  const category = "Slack";
  const botToken = process.env.SLACK_BOT_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!botToken && !signingSecret) {
    results.push({ category, label: "SLACK_BOT_TOKEN not set (Slack is optional)", status: "skip" });
    results.push({ category, label: "SLACK_SIGNING_SECRET not set", status: "skip" });
    return;
  }
  if (botToken) results.push({ category, label: "SLACK_BOT_TOKEN", status: "pass" });
  else results.push({ category, label: "SLACK_BOT_TOKEN", status: "fail", fix: "Set SLACK_BOT_TOKEN" });
  if (signingSecret) results.push({ category, label: "SLACK_SIGNING_SECRET", status: "pass" });
  else results.push({ category, label: "SLACK_SIGNING_SECRET", status: "fail", fix: "Set SLACK_SIGNING_SECRET" });
}

async function checkDeploys(
  apiKey: string,
  serviceId: string,
  label: string,
  results: CheckResult[],
): Promise<void> {
  const category = "Recent deploys";
  try {
    const deploys = await render.listDeploys(apiKey, serviceId);
    if (deploys.length === 0) {
      results.push({ category, label: `${label} last deploy`, status: "warn", detail: "no deploys found" });
      return;
    }
    const d = deploys[0];
    const age = timeAgo(d.createdAt);
    const commitShort = d.commit?.id.slice(0, 7) ?? "unknown";
    const isBad = d.status === "build_failed" || d.status === "deactivated";
    results.push({
      category,
      label: `${label} last deployed ${age}`,
      status: isBad ? "fail" : "pass",
      detail: `commit ${commitShort}, status: ${d.status}`,
      fix: isBad ? `Check ${label.toLowerCase()} deploy logs` : undefined,
    });
  } catch (e) {
    results.push({ category, label: `${label} deploys`, status: "fail", detail: String(e) });
  }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

async function doctorLocal(opts: DoctorOptions): Promise<boolean> {
  console.log("\n\x1b[1mrender-factory local health check\x1b[0m");
  console.log("==================================\n");

  const results: CheckResult[] = [];
  const category = "Local development";

  const hasDocker = await commandExists("docker");
  results.push({ category, label: "Docker installed", status: hasDocker ? "pass" : "fail", fix: hasDocker ? undefined : "Install Docker: https://docs.docker.com/get-docker/" });

  const hasRenderCli = await commandExists("render");
  results.push({ category, label: "Render CLI installed", status: hasRenderCli ? "pass" : "warn", detail: hasRenderCli ? undefined : "optional, needed for `render workflows dev`", fix: hasRenderCli ? undefined : "npm i -g @renderinc/cli" });

  const { existsSync } = await import("node:fs");
  const hasEnv = existsSync(".env");
  results.push({ category, label: ".env file exists", status: hasEnv ? "pass" : "fail", fix: hasEnv ? undefined : "Copy .env.example to .env and fill in your keys" });

  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenaiKey = !!process.env.OPENAI_API_KEY;
  results.push({ category, label: "LLM provider key set", status: hasAnthropicKey || hasOpenaiKey ? "pass" : "fail", fix: "Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env" });

  printResults(results, !!opts.json);
  return results.every((r) => r.status !== "fail");
}

async function commandExists(cmd: string): Promise<boolean> {
  const { exec } = await import("node:child_process");
  return new Promise((resolve) => {
    exec(`which ${cmd}`, (err) => resolve(!err));
  });
}
