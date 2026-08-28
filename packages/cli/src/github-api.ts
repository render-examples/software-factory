const BASE = "https://api.github.com";

export interface GitHubUser {
  login: string;
  type: string;
}

export interface GitHubRepo {
  full_name: string;
  permissions?: { push?: boolean; pull?: boolean; admin?: boolean };
}

export interface GitHubHook {
  id: number;
  config: { url?: string; content_type?: string };
  events: string[];
  active: boolean;
}

async function ghFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${path} — ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function getUser(token: string): Promise<GitHubUser> {
  return ghFetch<GitHubUser>("/user", token);
}

export async function listRepos(token: string): Promise<GitHubRepo[]> {
  return ghFetch<GitHubRepo[]>("/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", token);
}

export async function listHooks(token: string, owner: string, repo: string): Promise<GitHubHook[]> {
  try {
    return await ghFetch<GitHubHook[]>(`/repos/${owner}/${repo}/hooks`, token);
  } catch {
    return [];
  }
}

export async function validateToken(token: string): Promise<{
  valid: boolean;
  user?: GitHubUser;
  repos?: GitHubRepo[];
  scopes?: string;
}> {
  try {
    const user = await getUser(token);
    const repos = await listRepos(token);
    return { valid: true, user, repos };
  } catch {
    return { valid: false };
  }
}
