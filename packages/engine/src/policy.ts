/**
 * Policy Engine — unified access control + credential routing.
 *
 * Every tool invocation is evaluated against policy before execution. The policy
 * decision determines whether the call proceeds, is denied, or escalated to a
 * human. When allowed, the decision also specifies which credential to use,
 * decoupling tools from direct credential access.
 *
 * Design principles:
 * - Enforcement in the runtime, not the prompt
 * - Default-deny for writes; explicit allow required
 * - One canonical location for all policy (no split across frontmatter + yaml)
 * - Credential routing is a policy decision, not a tool concern
 * - Every decision is auditable
 */

// --- Core types ---

export type PolicyEffect = "allow" | "deny" | "escalate";

export interface PolicyDecision {
  effect: PolicyEffect;
  reason?: string;
  /** Credential to use for this action (resolved by policy, not the tool). */
  credential?: CredentialRef;
}

export interface CredentialRef {
  /** Credential ID from the policy config's `credentials` map. */
  id: string;
  /** Resolved value (populated by the credential store at evaluation time). */
  value?: string;
  /** Additional metadata (e.g. token type, expiry). */
  meta?: Record<string, unknown>;
}

export interface PolicyInput {
  /** The human who initiated the work (may be undefined for webhook-triggered runs). */
  principal?: Principal;
  /** Which agent is acting. */
  agent: AgentIdentity;
  /** The tool call being evaluated. */
  tool: ToolCallInfo;
  /** Runtime context for stateful decisions (budget, ratchet, etc.). */
  context: PolicyContext;
}

export interface Principal {
  id: string;
  roles?: string[];
}

export interface AgentIdentity {
  name: string;
  workflow?: string;
  runId: string;
}

export interface ToolCallInfo {
  name: string;
  input: unknown;
  /** The tool source namespace (e.g. "sandbox", "github", "render"). */
  source?: string;
}

export interface PolicyContext {
  runId: string;
  threadId?: string;
  iteration: number;
  costSoFar: number;
  /** Fields that the trust ratchet has revoked. */
  revokedCapabilities: ReadonlySet<string>;
}

// --- Credential config ---

export interface CredentialConfig {
  id: string;
  type: "env" | "static" | "github-app";
  /** Env var name (for type: "env"). */
  envVar?: string;
  /** Static value (for type: "static" — not recommended for production). */
  value?: string;
  /** GitHub App fields (for type: "github-app"). */
  appId?: string;
  privateKeyEnv?: string;
  installationId?: string;
}

// --- Workflow-scoped policy ---

export interface WorkflowPolicy {
  /** Credential bindings for this workflow: source → credential ID. */
  credentials?: Record<string, string>;
  /** Tools that require human approval in this workflow. */
  escalate?: string[];
  /** Tools that are hard-denied in this workflow. */
  deny?: string[];
}

// --- Policy configuration (the single canonical source) ---

export interface PolicyConfig {
  /** Credential definitions. */
  credentials: Record<string, CredentialConfig>;
  /** Project-wide defaults (apply unless overridden by workflow). */
  defaults?: {
    escalate?: string[];
    deny?: string[];
  };
  /** Per-workflow policy. */
  workflows: Record<string, WorkflowPolicy>;
}

// --- Engine interface ---

export interface PolicyEngine {
  evaluate(input: PolicyInput): Promise<PolicyDecision>;
}

// --- Audit record ---

export interface PolicyAuditRecord {
  ts: string;
  runId: string;
  agentName: string;
  principalId?: string;
  tool: string;
  effect: PolicyEffect;
  reason?: string;
  credentialId?: string;
  evaluationMs: number;
}
