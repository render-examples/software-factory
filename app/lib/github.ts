// GitHub REST client for workflow side-effects (issues, PRs, reviews).
// Lives in lib/ (not tools/) so writes happen under workflow control,
// not as model-callable tools. Auth: fine-grained PAT via GITHUB_TOKEN.

const DEFAULT_API = "https://api.github.com";

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  user: string;
  htmlUrl: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  head: string;
  base: string;
  state: string;
  user: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  side?: "LEFT" | "RIGHT";
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

interface RequestOptions {
  body?: unknown;
  accept?: string;
}

export class GitHub {
  private readonly api: string;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    api = process.env.GITHUB_API_URL ?? DEFAULT_API,
  ) {
    this.api = api.replace(/\/$/, "");
  }

  private redact(s: string): string {
    return this.token ? s.split(this.token).join("***") : s;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: opts.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "render-factory-demo",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.fetchImpl(`${this.api}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GitHubError(
        res.status,
        this.redact(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`),
        text,
      );
    }
    if (res.status === 204) return undefined as T;
    const accept = opts.accept ?? "";
    if (accept.includes("diff") || accept.includes("raw")) {
      return (await res.text()) as T;
    }
    return (await res.json()) as T;
  }

  // --- Issues ---

  async getIssue(ref: RepoRef, number: number): Promise<Issue> {
    const raw = await this.request<RawIssue>("GET", `/repos/${ref.owner}/${ref.repo}/issues/${number}`);
    return toIssue(raw);
  }

  async listIssueComments(ref: RepoRef, number: number): Promise<IssueComment[]> {
    const raw = await this.request<RawComment[]>(
      "GET",
      `/repos/${ref.owner}/${ref.repo}/issues/${number}/comments?per_page=100`,
    );
    return raw.map((c) => ({
      id: c.id,
      body: c.body ?? "",
      user: c.user?.login ?? "unknown",
      createdAt: c.created_at,
    }));
  }

  async createIssueComment(ref: RepoRef, number: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${ref.owner}/${ref.repo}/issues/${number}/comments`, { body: { body } });
  }

  async addLabels(ref: RepoRef, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.request("POST", `/repos/${ref.owner}/${ref.repo}/issues/${number}/labels`, { body: { labels } });
  }

  /** Remove a label. A 404 (already absent) is treated as success. */
  async removeLabel(ref: RepoRef, number: number, label: string): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/repos/${ref.owner}/${ref.repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
      );
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return;
      throw err;
    }
  }

  // --- Pull requests ---

  async getPull(ref: RepoRef, number: number): Promise<PullRequest> {
    const raw = await this.request<RawPull>("GET", `/repos/${ref.owner}/${ref.repo}/pulls/${number}`);
    return toPull(raw);
  }

  async listPullFiles(ref: RepoRef, number: number): Promise<PullFile[]> {
    const raw = await this.request<RawFile[]>(
      "GET",
      `/repos/${ref.owner}/${ref.repo}/pulls/${number}/files?per_page=100`,
    );
    return raw.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }));
  }

  async findOpenPullByHead(ref: RepoRef, branch: string): Promise<PullRequest | null> {
    const raw = await this.request<RawPull[]>(
      "GET",
      `/repos/${ref.owner}/${ref.repo}/pulls?head=${ref.owner}:${encodeURIComponent(branch)}&state=open`,
    );
    return raw.length > 0 ? toPull(raw[0]) : null;
  }

  async createPull(
    ref: RepoRef,
    args: { title: string; head: string; base: string; body: string },
  ): Promise<PullRequest> {
    const raw = await this.request<RawPull>("POST", `/repos/${ref.owner}/${ref.repo}/pulls`, { body: args });
    return toPull(raw);
  }

  /** Reuse an existing open PR for the same head branch, or create one. */
  async ensurePull(
    ref: RepoRef,
    args: { title: string; head: string; base: string; body: string },
  ): Promise<PullRequest> {
    const existing = await this.findOpenPullByHead(ref, args.head);
    if (existing) return existing;
    return this.createPull(ref, args);
  }

  /**
   * Submit a review. Falls back to body-only if GitHub returns 422
   * (inline comments targeting lines outside the diff hunk).
   */
  async createReview(
    ref: RepoRef,
    number: number,
    review: { event: ReviewEvent; body: string; comments?: ReviewComment[] },
  ): Promise<void> {
    const path = `/repos/${ref.owner}/${ref.repo}/pulls/${number}/reviews`;
    const comments = (review.comments ?? []).filter((c) => c.path && Number.isFinite(c.line));
    try {
      await this.request("POST", path, {
        body: {
          event: review.event,
          body: review.body,
          comments: comments.map((c) => ({ path: c.path, line: c.line, side: c.side ?? "RIGHT", body: c.body })),
        },
      });
    } catch (err) {
      if (err instanceof GitHubError && err.status === 422 && comments.length > 0) {
        await this.request("POST", path, { body: { event: review.event, body: review.body } });
        return;
      }
      throw err;
    }
  }
}

/** Build a client from GITHUB_TOKEN. Throws if unset. */
export function githubFromEnv(fetchImpl: typeof fetch = fetch): GitHub {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set — a fine-grained PAT is required.");
  }
  return new GitHub(token, fetchImpl);
}

// --- raw payload shapes + mappers ---

interface RawUser {
  login: string;
}
interface RawLabel {
  name: string;
}
interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: (RawLabel | string)[];
  user: RawUser | null;
  html_url: string;
}
interface RawComment {
  id: number;
  body: string | null;
  user: RawUser | null;
  created_at: string;
}
interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}
interface RawPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
  state: string;
  user: RawUser | null;
}

function toIssue(raw: RawIssue): Issue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    labels: raw.labels.map((l) => (typeof l === "string" ? l : l.name)),
    user: raw.user?.login ?? "unknown",
    htmlUrl: raw.html_url,
  };
}

function toPull(raw: RawPull): PullRequest {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    htmlUrl: raw.html_url,
    head: raw.head.ref,
    base: raw.base.ref,
    state: raw.state,
    user: raw.user?.login ?? "unknown",
  };
}
