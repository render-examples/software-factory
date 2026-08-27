import type {
  PolicyEngine,
  PolicyInput,
  PolicyDecision,
  PolicyConfig,
  CredentialConfig,
  CredentialRef,
  WorkflowPolicy,
} from "./policy.js";
import { getInstallationToken } from "./credentials/github-app.js";

/**
 * Built-in policy engine: workflow-scoped access control + credential routing.
 *
 * Evaluation:
 * 1. Resolve the active workflow's policy (fall back to defaults)
 * 2. Check deny list (hard block)
 * 3. Check trust ratchet (revoked capabilities)
 * 4. Check escalate list (requires human approval)
 * 5. Allow + resolve credential for the tool's source
 */
export class BuiltinPolicyEngine implements PolicyEngine {
  private readonly config: PolicyConfig;

  constructor(config: PolicyConfig) {
    this.config = config;
  }

  async evaluate(input: PolicyInput): Promise<PolicyDecision> {
    const workflowName = input.agent.workflow;
    const wfPolicy = workflowName ? this.config.workflows[workflowName] : undefined;

    const denyList = mergeList(this.config.defaults?.deny, wfPolicy?.deny);
    const escalateList = mergeList(this.config.defaults?.escalate, wfPolicy?.escalate);

    const toolName = input.tool.name;
    const source = input.tool.source ?? toolName.split("__")[0];

    // 1. Hard denies
    if (matchesAny(denyList, toolName)) {
      return { effect: "deny", reason: `Tool "${toolName}" is denied by policy` };
    }

    // 2. Trust ratchet
    if (input.context.revokedCapabilities.size > 0) {
      if (
        input.context.revokedCapabilities.has(toolName) ||
        input.context.revokedCapabilities.has(source) ||
        input.context.revokedCapabilities.has("*")
      ) {
        return { effect: "deny", reason: "Capability revoked by trust ratchet" };
      }
    }

    // 3. Escalate (requires human approval)
    if (matchesAny(escalateList, toolName)) {
      return { effect: "escalate", reason: `Tool "${toolName}" requires approval` };
    }

    // 4. Allow + credential routing
    const credential = await this.resolveCredentialForSource(source, wfPolicy);
    return { effect: "allow", credential };
  }

  private async resolveCredentialForSource(
    source: string,
    wfPolicy: WorkflowPolicy | undefined,
  ): Promise<CredentialRef | undefined> {
    const credentialId = wfPolicy?.credentials?.[source];
    if (!credentialId) return undefined;

    const config = this.config.credentials[credentialId];
    if (!config) return undefined;

    const value = await resolveCredentialValue(config);
    return { id: credentialId, value };
  }
}

async function resolveCredentialValue(config: CredentialConfig): Promise<string | undefined> {
  switch (config.type) {
    case "env":
      return config.envVar ? process.env[config.envVar] : undefined;
    case "static":
      return config.value;
    case "github-app": {
      const appId = config.appId;
      const privateKey = config.privateKeyEnv ? process.env[config.privateKeyEnv] : undefined;
      const installationId = config.installationId;
      if (!appId || !privateKey || !installationId) {
        console.warn(`[policy] github-app credential "${config.id}" missing appId, privateKey, or installationId`);
        return undefined;
      }
      return getInstallationToken({ appId, privateKey, installationId });
    }
    default:
      return undefined;
  }
}

function mergeList(defaults?: string[], override?: string[]): string[] {
  if (!defaults && !override) return [];
  if (!defaults) return override!;
  if (!override) return defaults;
  return [...new Set([...defaults, ...override])];
}

function matchesAny(patterns: string[], value: string): boolean {
  for (const pattern of patterns) {
    if (pattern === "*") return true;
    if (pattern.endsWith("*") && value.startsWith(pattern.slice(0, -1))) return true;
    if (value === pattern) return true;
  }
  return false;
}
