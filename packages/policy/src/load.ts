import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { PolicyDocument } from "./types.js";

export class PolicyValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Policy is invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "PolicyValidationError";
  }
}

const KNOWN_WORKFLOWS = new Set(["review", "bug", "feature"]);
const KNOWN_GATES = new Set(["approve_spec", "approve_plan"]);
const KNOWN_PERMISSIONS = new Set([
  "comment_on_pr",
  "comment_on_issue",
  "push_branch",
  "push_factory_branch",
  "open_draft_pr",
  "merge",
]);
const KNOWN_ELIGIBILITY = new Set([
  "max_files",
  "max_changed_lines",
  "allowed_paths",
  "denied_paths",
]);

export function validatePolicy(doc: unknown): PolicyDocument {
  const problems: string[] = [];
  const d = doc as Partial<PolicyDocument> | null;

  if (!d || typeof d !== "object") throw new PolicyValidationError(["policy must be an object"]);
  if (typeof d.version !== "string" || d.version.length === 0) {
    problems.push("`version` is required and must be a non-empty string (it is pinned onto runs)");
  }
  if (!d.repositories || typeof d.repositories !== "object") {
    problems.push("`repositories` is required");
  }

  for (const [repoName, repo] of Object.entries(d.repositories ?? {})) {
    const at = `repositories.${repoName}`;
    if (typeof repo.enabled !== "boolean") problems.push(`${at}.enabled must be a boolean`);
    if (typeof repo.default_branch !== "string") problems.push(`${at}.default_branch must be a string`);
    if (!repo.workflows || Object.keys(repo.workflows).length === 0) {
      problems.push(`${at}.workflows must declare at least one workflow`);
    }

    for (const [wfName, wf] of Object.entries(repo.workflows ?? {})) {
      const wfAt = `${at}.workflows.${wfName}`;
      if (!KNOWN_WORKFLOWS.has(wfName)) {
        problems.push(`${wfAt} is not a known workflow (expected one of ${[...KNOWN_WORKFLOWS].join(", ")})`);
      }
      if (!wf?.trigger?.label) {
        problems.push(`${wfAt}.trigger.label is required — humans choose the workflow by label`);
      }
      for (const key of Object.keys(wf?.eligibility ?? {})) {
        if (!KNOWN_ELIGIBILITY.has(key)) problems.push(`${wfAt}.eligibility.${key} is not a known key`);
      }
      for (const key of Object.keys(wf?.gates ?? {})) {
        if (!KNOWN_GATES.has(key)) problems.push(`${wfAt}.gates.${key} is not a known gate`);
      }
      for (const key of Object.keys(wf?.permissions ?? {})) {
        if (!KNOWN_PERMISSIONS.has(key)) problems.push(`${wfAt}.permissions.${key} is not a known permission`);
      }
      if (wf?.permissions?.merge === true) {
        problems.push(`${wfAt}.permissions.merge must not be true: a human merges every change in v1`);
      }
    }
  }

  for (const [repoName, repo] of Object.entries(d.repositories ?? {})) {
    const seen = new Map<string, string>();
    for (const [wfName, wf] of Object.entries(repo.workflows ?? {})) {
      const label = wf?.trigger?.label;
      if (!label) continue;
      const prior = seen.get(label);
      if (prior) {
        problems.push(
          `repositories.${repoName}: label "${label}" triggers both ${prior} and ${wfName}; routing would be ambiguous`,
        );
      }
      seen.set(label, wfName);
    }
  }

  if (problems.length > 0) throw new PolicyValidationError(problems);
  return d as PolicyDocument;
}

export function policyDigest(doc: PolicyDocument): string {
  return `sha256:${createHash("sha256").update(canonicalize(doc)).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

export function loadPolicyFile(path: string): PolicyDocument {
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PolicyValidationError([`${path} is not valid JSON: ${(err as Error).message}`]);
  }
  return validatePolicy(parsed);
}
