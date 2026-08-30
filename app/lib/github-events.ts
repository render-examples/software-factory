// Normalized GitHub webhook payloads consumed by workflow tasks.

export interface RepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
}

export interface NormalizedIssueEvent {
  kind: "issue";
  event: "issues" | "issue_comment";
  action: string;
  repo: RepoInfo;
  issue: {
    number: number;
    title: string;
    body: string;
    labels: string[];
    user: string;
    htmlUrl: string;
    /** True when the "issue" is actually a PR conversation. */
    isPullRequest: boolean;
  };
  comment?: { body: string; user: string };
  sender: { login: string; type: string };
}

export interface NormalizedPullEvent {
  kind: "pull";
  event: "pull_request";
  action: string;
  repo: RepoInfo;
  pull: {
    number: number;
    title: string;
    body: string;
    head: string;
    base: string;
    user: string;
    htmlUrl: string;
    draft: boolean;
  };
  sender: { login: string; type: string };
}

export type NormalizedGitHubEvent =
  | NormalizedIssueEvent
  | NormalizedPullEvent
  | { kind: "skip"; event: string };

// Partial types for raw GitHub webhook payloads.
interface RawRepo {
  name: string;
  owner: { login: string };
  full_name: string;
  default_branch: string;
}
interface RawUser {
  login: string;
  type?: string;
}
interface RawLabel {
  name: string;
}
interface RawWebhookPayload {
  action?: string;
  repository?: RawRepo;
  sender?: RawUser;
  issue?: {
    number: number;
    title: string;
    body: string | null;
    labels?: (RawLabel | string)[];
    user?: RawUser;
    html_url: string;
    pull_request?: unknown;
  };
  comment?: { body: string | null; user?: RawUser };
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    head: { ref: string };
    base: { ref: string };
    user?: RawUser;
    html_url: string;
    draft?: boolean;
  };
}

function repoInfo(r: RawRepo): RepoInfo {
  return { owner: r.owner.login, repo: r.name, fullName: r.full_name, defaultBranch: r.default_branch };
}

function labels(list?: (RawLabel | string)[]): string[] {
  return (list ?? []).map((l) => (typeof l === "string" ? l : l.name));
}

export function normalizeGitHubEvent(event: string, payload: unknown): NormalizedGitHubEvent {
  const p = payload as RawWebhookPayload;
  const sender = { login: p.sender?.login ?? "unknown", type: p.sender?.type ?? "User" };

  if ((event === "issues" || event === "issue_comment") && p.repository && p.issue) {
    return {
      kind: "issue",
      event,
      action: p.action ?? "",
      repo: repoInfo(p.repository),
      issue: {
        number: p.issue.number,
        title: p.issue.title,
        body: p.issue.body ?? "",
        labels: labels(p.issue.labels),
        user: p.issue.user?.login ?? "unknown",
        htmlUrl: p.issue.html_url,
        isPullRequest: Boolean(p.issue.pull_request),
      },
      comment: p.comment ? { body: p.comment.body ?? "", user: p.comment.user?.login ?? "unknown" } : undefined,
      sender,
    };
  }

  if ((event === "pull_request" || event === "pull_request_review") && p.repository && p.pull_request) {
    return {
      kind: "pull",
      event: "pull_request",
      action: event === "pull_request_review" ? "review_submitted" : (p.action ?? ""),
      repo: repoInfo(p.repository),
      pull: {
        number: p.pull_request.number,
        title: p.pull_request.title,
        body: p.pull_request.body ?? "",
        head: p.pull_request.head.ref,
        base: p.pull_request.base.ref,
        user: p.pull_request.user?.login ?? "unknown",
        htmlUrl: p.pull_request.html_url,
        draft: Boolean(p.pull_request.draft),
      },
      sender,
    };
  }

  return { kind: "skip", event };
}
