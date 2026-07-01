import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";
import { LoadError, ERR_UNKNOWN_FIELD, ERR_EMPTY_BODY, ERR_FRONTMATTER_VALIDATION } from "./errors.js";

const KNOWN_FIELDS = new Set([
  "model", "provider", "description", "tools", "subagents",
  "skills", "permissions", "output", "context", "budget",
  "plan", "sampling", "runner", "interactive",
]);

const FrontmatterSchema = z.object({
  model: z.string().optional(),
  provider: z.enum(["anthropic", "openai"]).optional(),
  description: z.string().optional(),
  tools: z.array(z.string()).optional().default([]),
  subagents: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  permissions: z.object({
    requireApproval: z.array(z.string()).optional(),
  }).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  context: z.object({
    compaction: z.string().optional(),
    maxContextTokens: z.number().optional(),
  }).optional(),
  budget: z.object({
    maxIterations: z.number().optional(),
    maxTokens: z.number().optional(),
    maxCostUsd: z.union([z.number(), z.null()]).optional(),
    maxWallSeconds: z.number().optional(),
  }).optional(),
  plan: z.string().optional(),
  sampling: z.object({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    maxOutputTokens: z.number().optional(),
  }).optional(),
  runner: z.string().optional(),
  /** Conversational agent: parks on `awaitInput()` between turns instead of completing. */
  interactive: z.boolean().optional(),
});

export type ParsedFrontmatter = z.infer<typeof FrontmatterSchema>;

export interface ParsedMarkdown {
  frontmatter: ParsedFrontmatter;
  body: string;
}

/** Cap the frontmatter block size before YAML parsing (defense-in-depth DoS
 *  guard; the `yaml` library also caps alias expansion at 100 by default). */
const MAX_FRONTMATTER_BYTES = 64 * 1024;

export function parseAgentMarkdown(content: string, filename: string): ParsedMarkdown {
  // Normalize CRLF so Windows-authored files parse identically — the regex below
  // anchors on `\n`, so `---\r\n` would otherwise skip frontmatter entirely (CR-13).
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  let rawFrontmatter: Record<string, unknown> = {};
  let body: string;

  if (match) {
    if (match[1].length > MAX_FRONTMATTER_BYTES) {
      throw new LoadError(
        ERR_FRONTMATTER_VALIDATION,
        `Agent "${filename}" frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes`,
        { agent: filename },
      );
    }
    rawFrontmatter = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
    body = match[2].trim();
  } else {
    body = normalized.trim();
  }

  if (!body) {
    throw new LoadError(ERR_EMPTY_BODY, `Agent "${filename}" has an empty system prompt body`);
  }

  for (const key of Object.keys(rawFrontmatter)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new LoadError(
        ERR_UNKNOWN_FIELD,
        `Agent "${filename}" has unknown frontmatter field: "${key}"`,
        { field: key, agent: filename },
      );
    }
  }

  const result = FrontmatterSchema.safeParse(rawFrontmatter);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new LoadError(
      ERR_FRONTMATTER_VALIDATION,
      `Agent "${filename}" frontmatter validation failed: ${issues}`,
      { agent: filename, issues: result.error.issues },
    );
  }

  return { frontmatter: result.data, body };
}
