/**
 * GitHub tools — read-only repo access via the GitHub REST API.
 *
 * Lets agents browse repositories, read files, search code, and list
 * directory contents without cloning or spinning up a sandbox.
 */
import { z } from "zod";
import type { Tool, ToolSource, ToolResult, ToolContext } from "#factory-sdk";

const MAX_CONTENT = 100_000;

function truncate(s: string, limit = MAX_CONTENT): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n... (truncated, ${s.length - limit} chars omitted)`;
}

function ghToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return token;
}

async function ghFetch(path: string, accept?: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "render-factory",
    },
  });
}

// ---------------------------------------------------------------------------
// Tool: github_read_file
// ---------------------------------------------------------------------------

const readFileSchema = {
  owner: z.string().describe("Repo owner (e.g. 'render-lab')."),
  repo: z.string().describe("Repo name (e.g. 'render-factory')."),
  path: z.string().describe("File path within the repo (e.g. 'src/index.ts')."),
  ref: z.string().optional().describe("Branch, tag, or SHA. Defaults to the default branch."),
};

const readFileTool: Tool<typeof readFileSchema> = {
  name: "github_read_file",
  description: "Read a file from a GitHub repository. Returns the file contents as UTF-8 text.",
  inputSchema: readFileSchema,
  async invoke(input): Promise<ToolResult> {
    const refParam = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : "";
    const res = await ghFetch(
      `/repos/${input.owner}/${input.repo}/contents/${input.path}${refParam}`,
      "application/vnd.github.raw+json",
    );
    if (!res.ok) {
      const text = await res.text();
      return { content: `GitHub API ${res.status}: ${text.slice(0, 300)}`, isError: true };
    }
    const content = await res.text();
    return { content: truncate(content) };
  },
};

// ---------------------------------------------------------------------------
// Tool: github_list_dir
// ---------------------------------------------------------------------------

const listDirSchema = {
  owner: z.string().describe("Repo owner."),
  repo: z.string().describe("Repo name."),
  path: z.string().optional().describe("Directory path. Defaults to repo root."),
  ref: z.string().optional().describe("Branch, tag, or SHA."),
};

const listDirTool: Tool<typeof listDirSchema> = {
  name: "github_list_dir",
  description: "List files and directories at a path in a GitHub repository.",
  inputSchema: listDirSchema,
  async invoke(input): Promise<ToolResult> {
    const dirPath = input.path || "";
    const refParam = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : "";
    const res = await ghFetch(
      `/repos/${input.owner}/${input.repo}/contents/${dirPath}${refParam}`,
    );
    if (!res.ok) {
      const text = await res.text();
      return { content: `GitHub API ${res.status}: ${text.slice(0, 300)}`, isError: true };
    }
    const items = (await res.json()) as Array<{ name: string; type: string; size: number }>;
    if (!Array.isArray(items)) {
      return { content: "Path is a file, not a directory. Use github_read_file instead.", isError: true };
    }
    const lines = items.map((i) =>
      i.type === "dir" ? `${i.name}/` : `${i.name} (${i.size}B)`,
    );
    return { content: lines.join("\n") || "(empty directory)" };
  },
};

// ---------------------------------------------------------------------------
// Tool: github_search_code
// ---------------------------------------------------------------------------

const searchCodeSchema = {
  query: z.string().describe("Search query. Use GitHub code search syntax (e.g. 'createApp repo:render-lab/render-factory')."),
  per_page: z.number().optional().describe("Results per page (max 30). Defaults to 10."),
};

const searchCodeTool: Tool<typeof searchCodeSchema> = {
  name: "github_search_code",
  description:
    "Search code across GitHub repositories. Use GitHub search syntax: " +
    "'query repo:owner/name', 'query path:src/', 'query language:typescript', etc.",
  inputSchema: searchCodeSchema,
  async invoke(input): Promise<ToolResult> {
    const perPage = Math.min(input.per_page ?? 10, 30);
    const res = await ghFetch(
      `/search/code?q=${encodeURIComponent(input.query)}&per_page=${perPage}`,
    );
    if (!res.ok) {
      const text = await res.text();
      return { content: `GitHub API ${res.status}: ${text.slice(0, 300)}`, isError: true };
    }
    const data = (await res.json()) as {
      total_count: number;
      items: Array<{
        name: string;
        path: string;
        repository: { full_name: string };
        html_url: string;
        text_matches?: Array<{ fragment: string }>;
      }>;
    };
    if (data.items.length === 0) {
      return { content: `No results (${data.total_count} total matches).` };
    }
    const lines = data.items.map((item) => {
      const fragments = item.text_matches?.map((m) => `  ${m.fragment}`).join("\n") ?? "";
      return `${item.repository.full_name}:${item.path}${fragments ? "\n" + fragments : ""}`;
    });
    return { content: `${data.total_count} total matches:\n\n${lines.join("\n\n")}` };
  },
};

// ---------------------------------------------------------------------------
// Tool: github_get_pull
// ---------------------------------------------------------------------------

const getPullSchema = {
  owner: z.string().describe("Repo owner."),
  repo: z.string().describe("Repo name."),
  number: z.number().describe("Pull request number."),
};

const getPullTool: Tool<typeof getPullSchema> = {
  name: "github_get_pull",
  description: "Get details and diff of a GitHub pull request.",
  inputSchema: getPullSchema,
  async invoke(input): Promise<ToolResult> {
    const [prRes, diffRes] = await Promise.all([
      ghFetch(`/repos/${input.owner}/${input.repo}/pulls/${input.number}`),
      ghFetch(
        `/repos/${input.owner}/${input.repo}/pulls/${input.number}`,
        "application/vnd.github.diff",
      ),
    ]);
    if (!prRes.ok) {
      const text = await prRes.text();
      return { content: `GitHub API ${prRes.status}: ${text.slice(0, 300)}`, isError: true };
    }
    const pr = (await prRes.json()) as {
      title: string;
      body: string | null;
      state: string;
      html_url: string;
      head: { ref: string };
      base: { ref: string };
      user: { login: string };
      changed_files: number;
      additions: number;
      deletions: number;
    };
    const diff = diffRes.ok ? await diffRes.text() : "(diff unavailable)";
    return {
      content:
        `# PR #${input.number}: ${pr.title}\n` +
        `Author: ${pr.user.login} | State: ${pr.state}\n` +
        `${pr.head.ref} → ${pr.base.ref} | +${pr.additions} -${pr.deletions} (${pr.changed_files} files)\n` +
        `${pr.html_url}\n\n` +
        `${pr.body ?? "(no description)"}\n\n` +
        `## Diff\n\`\`\`diff\n${truncate(diff, 50_000)}\n\`\`\``,
    };
  },
};

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export class GitHubToolSource implements ToolSource {
  readonly id = "github";

  resolve() {
    return [readFileTool, listDirTool, searchCodeTool, getPullTool];
  }
}
