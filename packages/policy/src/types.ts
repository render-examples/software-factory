/**
 * Deterministic repository policy.
 *
 * Humans choose the workflow. Verified configuration defines authority. Model
 * output does not affect policy decisions.
 */

export type Decision =
  | { outcome: "proceed" }
  | { outcome: "needs_approval"; gates: GateName[] }
  | { outcome: "decline"; reason: string; rule: string };

export type WorkflowName = "review" | "bug" | "feature";

export type GateName = "approve_spec" | "approve_plan";

export interface Permissions {
  comment_on_pr?: boolean;
  comment_on_issue?: boolean;
  push_branch?: boolean;
  push_factory_branch?: boolean;
  open_draft_pr?: boolean;
  merge?: boolean;
}

export interface Eligibility {
  max_files?: number;
  max_changed_lines?: number;
  allowed_paths?: string[];
  denied_paths?: string[];
}

export interface WorkflowPolicy {
  trigger: { label: string };
  eligibility?: Eligibility;
  checks?: string[];
  gates?: Partial<Record<GateName, boolean>>;
  permissions?: Permissions;
}

export interface RepositoryPolicy {
  enabled: boolean;
  default_branch: string;
  workflows: Partial<Record<WorkflowName, WorkflowPolicy>>;
}

export interface PolicyDocument {
  version: string;
  global_denied_paths?: string[];
  repositories: Record<string, RepositoryPolicy>;
}

export interface WorkTarget {
  repository: string;
  paths: string[];
  changedFiles: number;
  changedLines: number;
}

export interface TriggerContext {
  repository: string;
  label: string;
  actorHasWriteAccess: boolean;
}
