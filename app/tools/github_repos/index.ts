import { defineTool } from "@render-factory/sdk";

interface RepoEntry {
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  language: string | null;
  updated_at: string;
}

export default defineTool({
  name: "github_repos",
  description:
    "List GitHub repositories accessible to the configured GITHUB_TOKEN. " +
    "Returns repo names, visibility, language, and default branch. Use this to " +
    "discover which repos you can clone, explore, or target with workflows.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Optional search filter. When provided, searches repos by name/description. " +
          "When omitted, lists all accessible repos sorted by most recently updated.",
      },
      per_page: {
        type: "number",
        description: "Results per page (max 100). Default 30.",
      },
    },
  },
  async invoke(input) {
    const { query, per_page } = (input ?? {}) as { query?: string; per_page?: number };
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return { content: "GITHUB_TOKEN is not set", isError: true };
    }

    const limit = Math.min(per_page ?? 30, 100);
    const api = process.env.GITHUB_API_URL?.replace(/\/$/, "") ?? "https://api.github.com";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "render-factory",
    };

    let url: string;
    if (query) {
      const q = encodeURIComponent(query);
      url = `${api}/search/repositories?q=${q}+in:name,description&sort=updated&per_page=${limit}`;
    } else {
      url = `${api}/user/repos?sort=updated&per_page=${limit}&affiliation=owner,collaborator,organization_member`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { content: `GitHub API error ${res.status}: ${body.slice(0, 300)}`, isError: true };
    }

    const json = await res.json() as { items?: RepoEntry[] } | RepoEntry[];
    const repos: RepoEntry[] = Array.isArray(json) ? json : (json.items ?? []);

    if (repos.length === 0) {
      return query
        ? `No repositories found matching "${query}".`
        : "No accessible repositories found.";
    }

    const lines = repos.map((r) => {
      const visibility = r.private ? "private" : "public";
      const lang = r.language ?? "unknown";
      const desc = r.description ? ` — ${r.description}` : "";
      return `• ${r.full_name} (${visibility}, ${lang}, branch: ${r.default_branch})${desc}`;
    });

    const header = query
      ? `Repositories matching "${query}" (${repos.length} results):`
      : `Accessible repositories (${repos.length}, most recently updated):`;

    return [header, "", ...lines].join("\n");
  },
});
