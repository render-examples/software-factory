import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PolicyConfig, CredentialConfig, WorkflowPolicy } from "./policy.js";
import { BuiltinPolicyEngine } from "./policy-builtin.js";
import type { PolicyEngine } from "./policy.js";

interface RawPolicyConfig {
  credentials?: Record<string, { type: string; envVar?: string; value?: string; appId?: string; privateKeyEnv?: string; installationId?: string }>;
  defaults?: { escalate?: string[]; deny?: string[] };
  workflows?: Record<string, { credentials?: Record<string, string>; escalate?: string[]; deny?: string[] }>;
}

/**
 * Load policy from a JSON or YAML file and return a configured engine.
 * Returns a permissive allow-all engine when no policy file exists.
 */
export function loadPolicyEngine(projectRoot: string): PolicyEngine {
  const config = loadPolicyConfig(projectRoot);
  return new BuiltinPolicyEngine(config);
}

export function loadPolicyConfig(projectRoot: string): PolicyConfig {
  const candidates = [
    join(projectRoot, "policy.json"),
    join(projectRoot, "policy.yaml"),
    join(projectRoot, "policy.yml"),
  ];

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = parseConfig(raw, path);
      return normalize(parsed);
    } catch {
      continue;
    }
  }

  return defaultPolicyConfig();
}

function parseConfig(raw: string, path: string): RawPolicyConfig {
  if (path.endsWith(".json")) {
    return JSON.parse(raw);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require("yaml");
    return yaml.parse(raw);
  } catch {
    throw new Error(
      `Found ${path} but the 'yaml' package is not installed. Use policy.json or add 'yaml' as a dependency.`,
    );
  }
}

function normalize(raw: RawPolicyConfig): PolicyConfig {
  const credentials: Record<string, CredentialConfig> = {};
  if (raw.credentials) {
    for (const [id, cred] of Object.entries(raw.credentials)) {
      credentials[id] = {
        id,
        type: cred.type as CredentialConfig["type"],
        envVar: cred.envVar,
        value: cred.value,
        appId: cred.appId,
        privateKeyEnv: cred.privateKeyEnv,
        installationId: cred.installationId,
      };
    }
  }

  const workflows: Record<string, WorkflowPolicy> = {};
  if (raw.workflows) {
    for (const [name, wf] of Object.entries(raw.workflows)) {
      workflows[name] = {
        credentials: wf.credentials,
        escalate: wf.escalate,
        deny: wf.deny,
      };
    }
  }

  return {
    credentials,
    defaults: raw.defaults,
    workflows,
  };
}

function defaultPolicyConfig(): PolicyConfig {
  return { credentials: {}, workflows: {} };
}
