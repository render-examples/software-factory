import type {
  Decision,
  GateName,
  Permissions,
  PolicyDocument,
  RepositoryPolicy,
  TriggerContext,
  WorkflowName,
  WorkflowPolicy,
  WorkTarget,
} from "./types.js";

export function matchesGlob(path: string, pattern: string): boolean {
  const rx = globToRegExp(pattern);
  return rx.test(path);
}

function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      const isDoubleStar = pattern[i + 1] === "*";
      if (isDoubleStar) {
        const skipSlash = pattern[i + 2] === "/" ? 3 : 2;
        out += ".*";
        i += skipSlash;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    out += ch!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

export function resolveRouting(
  policy: PolicyDocument,
  ctx: TriggerContext,
): { workflow: WorkflowName; repo: RepositoryPolicy; wf: WorkflowPolicy } | undefined {
  const repo = policy.repositories[ctx.repository];
  if (!repo?.enabled) return undefined;

  for (const [name, wf] of Object.entries(repo.workflows)) {
    if (wf?.trigger.label === ctx.label) {
      return { workflow: name as WorkflowName, repo, wf };
    }
  }
  return undefined;
}

export function admit(policy: PolicyDocument, ctx: TriggerContext, target: WorkTarget): Decision {
  if (!ctx.actorHasWriteAccess) {
    return decline("the actor who applied the label lacks write access", "actor.write_access");
  }

  const repo = policy.repositories[ctx.repository];
  if (!repo) return decline(`repository ${ctx.repository} is not configured`, "repository.unknown");
  if (!repo.enabled) return decline(`repository ${ctx.repository} is disabled`, "repository.disabled");

  const routed = resolveRouting(policy, ctx);
  if (!routed) return decline(`no workflow is triggered by label ${ctx.label}`, "routing.no_match");

  const eligibility = checkEligibility(policy, routed.wf, target);
  if (eligibility.outcome !== "proceed") return eligibility;

  const gates = resolveGates(routed.wf);
  return gates.length > 0 ? { outcome: "needs_approval", gates } : { outcome: "proceed" };
}

export function checkEligibility(
  policy: PolicyDocument,
  wf: WorkflowPolicy,
  target: WorkTarget,
): Decision {
  for (const path of target.paths) {
    for (const pattern of policy.global_denied_paths ?? []) {
      if (matchesGlob(path, pattern)) {
        return decline(`${path} is globally protected (${pattern})`, "global_denied_paths");
      }
    }
  }

  const e = wf.eligibility;
  if (!e) return { outcome: "proceed" };

  for (const path of target.paths) {
    for (const pattern of e.denied_paths ?? []) {
      if (matchesGlob(path, pattern)) {
        return decline(`${path} is a protected path (${pattern})`, "denied_paths");
      }
    }
  }

  if (e.allowed_paths) {
    for (const path of target.paths) {
      const permitted = e.allowed_paths.some((pattern) => matchesGlob(path, pattern));
      if (!permitted) {
        return decline(`${path} is outside the allowed paths for this workflow`, "allowed_paths");
      }
    }
  }

  if (e.max_files !== undefined && target.changedFiles > e.max_files) {
    return decline(
      `${target.changedFiles} files changed, over the limit of ${e.max_files}`,
      "max_files",
    );
  }
  if (e.max_changed_lines !== undefined && target.changedLines > e.max_changed_lines) {
    return decline(
      `${target.changedLines} lines changed, over the limit of ${e.max_changed_lines}`,
      "max_changed_lines",
    );
  }

  return { outcome: "proceed" };
}

export function resolveAuthority(wf: WorkflowPolicy): Required<Permissions> {
  const p = wf.permissions ?? {};
  return {
    comment_on_pr: p.comment_on_pr ?? false,
    comment_on_issue: p.comment_on_issue ?? false,
    push_branch: p.push_branch ?? false,
    push_factory_branch: p.push_factory_branch ?? false,
    open_draft_pr: p.open_draft_pr ?? false,
    merge: false,
  };
}

export function resolveGates(wf: WorkflowPolicy): GateName[] {
  const order: GateName[] = ["approve_spec", "approve_plan"];
  return order.filter((gate) => wf.gates?.[gate] === true);
}

function decline(reason: string, rule: string): Decision {
  return { outcome: "decline", reason, rule };
}
