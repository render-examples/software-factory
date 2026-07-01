import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadAgentsFromDir } from "../../src/loader/load-agents.js";
import { parseAgentMarkdown } from "../../src/loader/frontmatter.js";
import { mergeFrontmatter, mergeBody } from "../../src/loader/shared-merge.js";
import { LoadError } from "../../src/loader/errors.js";

const FIXTURES = join(import.meta.dirname, "../__fixtures__");
const VALID_PROJECT = join(FIXTURES, "valid-project");

describe("loadAgentsFromDir", () => {
  it("loads a valid project and returns an AgentSet", async () => {
    const agents = await loadAgentsFromDir(VALID_PROJECT);
    expect(agents.has("security")).toBe(true);
    expect(agents.has("judge")).toBe(true);
    expect(agents.all()).toHaveLength(2);
  });

  it("resolves model tiers to ModelSpec", async () => {
    const agents = await loadAgentsFromDir(VALID_PROJECT);
    const judge = agents.get("judge");
    expect(judge.definition.model.provider).toBe("anthropic");
    expect(judge.definition.model.model).toBe("claude-opus-4-6");
  });

  it("resolves skills into SkillMetadata", async () => {
    const agents = await loadAgentsFromDir(VALID_PROJECT);
    const security = agents.get("security");
    expect(security.definition.skills).toHaveLength(1);
    expect(security.definition.skills![0].id).toBe("security-patterns");
    expect(security.definition.skills![0].content).toContain("SQL injection");
  });

  it("merges _shared.md frontmatter (agent wins on conflict)", async () => {
    const agents = await loadAgentsFromDir(VALID_PROJECT);
    const security = agents.get("security");
    expect(security.definition.budget?.maxCostUsd).toBe(2);
    expect(security.definition.budget?.maxIterations).toBe(30);
  });

  it("merges _shared.md body (prepend)", async () => {
    const agents = await loadAgentsFromDir(VALID_PROJECT);
    const security = agents.get("security");
    expect(security.definition.systemPrompt).toMatch(/^You are a helpful assistant/);
    expect(security.definition.systemPrompt).toContain("security reviewer");
  });

  it("unions tool arrays from _shared.md", async () => {
    const agents = await loadAgentsFromDir(VALID_PROJECT);
    const security = agents.get("security");
    expect(security.definition.tools).toContain("github");
    expect(security.definition.tools).toContain("sandbox");
  });

  it("errors clearly when passed the agents/ folder instead of the project root", async () => {
    const agentsDir = join(VALID_PROJECT, "agents");
    await expect(loadAgentsFromDir(agentsDir)).rejects.toThrow(/expects the project root/);
  });

  it("returns an empty AgentSet for a directory with no agent markdown (no false positive)", async () => {
    // The skills/ dir has no agents/ subdir and no top-level *.md — must not trip the guard.
    const agents = await loadAgentsFromDir(join(VALID_PROJECT, "skills"));
    expect(agents.all()).toEqual([]);
  });
});

describe("requireApproval on subagents (BUG-09)", () => {
  async function makeProject(leadFrontmatter: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ra-subagent-approval-"));
    await mkdir(join(dir, "agents"), { recursive: true });
    await writeFile(
      join(dir, "agents", "researcher.md"),
      `---\nmodel: medium\n---\nYou research things.\n`,
    );
    await writeFile(join(dir, "agents", "lead.md"), leadFrontmatter);
    return dir;
  }

  it("accepts requireApproval for a declared subagent delegation tool", async () => {
    const dir = await makeProject(
      `---\nmodel: medium\nsubagents: [researcher]\npermissions:\n  requireApproval: [subagents__researcher]\n---\nYou lead.\n`,
    );
    try {
      const agents = await loadAgentsFromDir(dir);
      expect(agents.get("lead").definition.permissions?.requireApproval).toContain("subagents__researcher");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still rejects requireApproval for a subagent that is not declared", async () => {
    const dir = await makeProject(
      `---\nmodel: medium\nsubagents: [researcher]\npermissions:\n  requireApproval: [subagents__ghostwriter]\n---\nYou lead.\n`,
    );
    try {
      await expect(loadAgentsFromDir(dir)).rejects.toThrow(/requireApproval/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseAgentMarkdown", () => {
  it("throws on empty body", () => {
    expect(() => parseAgentMarkdown("---\nmodel: medium\n---\n", "test")).toThrow(LoadError);
    expect(() => parseAgentMarkdown("---\nmodel: medium\n---\n", "test")).toThrow("empty system prompt");
  });

  it("throws on unknown frontmatter field", () => {
    expect(() => parseAgentMarkdown("---\nfoo: bar\n---\nHello", "test")).toThrow(LoadError);
    expect(() => parseAgentMarkdown("---\nfoo: bar\n---\nHello", "test")).toThrow("unknown frontmatter field");
  });
});

describe("mergeFrontmatter", () => {
  it("agent scalar wins over shared", () => {
    const result = mergeFrontmatter(
      { model: "medium", tools: [] },
      { model: "large", tools: [] },
    );
    expect(result.model).toBe("large");
  });

  it("shared scalar used when agent omits", () => {
    const result = mergeFrontmatter(
      { model: "medium", tools: [] },
      { tools: [] },
    );
    expect(result.model).toBe("medium");
  });

  it("arrays are unioned and deduped", () => {
    const result = mergeFrontmatter(
      { tools: ["a", "b"] },
      { tools: ["b", "c"] },
    );
    expect(result.tools).toEqual(["a", "b", "c"]);
  });

  it("nested objects deep-merge (agent leaf wins)", () => {
    const result = mergeFrontmatter(
      { tools: [], budget: { maxIterations: 30, maxCostUsd: 10 } },
      { tools: [], budget: { maxCostUsd: 2 } },
    );
    expect(result.budget?.maxIterations).toBe(30);
    expect(result.budget?.maxCostUsd).toBe(2);
  });
});

describe("mergeBody", () => {
  it("prepends shared body", () => {
    expect(mergeBody("shared", "agent")).toBe("shared\n\nagent");
  });

  it("returns agent body when shared is empty", () => {
    expect(mergeBody("", "agent")).toBe("agent");
  });
});
