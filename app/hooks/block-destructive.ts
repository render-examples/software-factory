/**
 * Block-destructive hook — vetoes tool calls containing dangerous commands.
 *
 * This is a defense-in-depth layer; the sandbox itself is ephemeral and
 * scoped. The hook catches common destructive patterns regardless of flag
 * ordering, quoting tricks, or command chaining.
 */
import type { Hook, HookContext } from "#factory/sdk";
import { factoryConfig } from "../../factory.config.js";

interface BlockRule {
  pattern: RegExp;
  label: string;
}

const BLOCKED_COMMANDS: BlockRule[] = [
  {
    pattern: /\brm\b[^|;]*(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|-r\b[^|;]*-f\b|-f\b[^|;]*-r\b|--recursive\b[^|;]*--force\b|--force\b[^|;]*--recursive\b)[^|;]*(?:\/(?:[\s";)|&]|$)|~)/,
    label: "recursive forced deletion of root or home",
  },
  {
    pattern: /\bgit\s+push\b.*(?:--force\b|-[^\s]*f\b)/,
    label: "git force push",
  },
  {
    pattern: /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE)\b/i,
    label: "destructive SQL statement",
  },
  {
    pattern: /\bmkfs\b/,
    label: "filesystem format",
  },
  {
    pattern: /\bdd\b.*\bif=/,
    label: "raw disk write (dd)",
  },
  {
    pattern: />\s*\/dev\/(?:sd|nvme|vd|xvd)/,
    label: "redirect to block device",
  },
  {
    pattern: /\bchmod\b.*(?:777|a\+rwx)\s+\//,
    label: "chmod world-writable on root path",
  },
];

const EXFILTRATION_PATTERNS: BlockRule[] = [
  {
    pattern: /\bcurl\b.*(?:--data\b|-[^\s]*d\b|-X\s*(?:POST|PUT)\b).*(?:GITHUB_TOKEN|ANTHROPIC_API_KEY|RENDER_API_KEY|DATABASE_URL)/i,
    label: "potential secret exfiltration via curl",
  },
  {
    pattern: /\bwget\b.*--post/i,
    label: "potential exfiltration via wget POST",
  },
];

const EVASION_PATTERNS: BlockRule[] = [
  {
    pattern: /\bbase64\b.*(?:-d|--decode)\b.*\|\s*(?:sh\b|bash\b|zsh\b)/,
    label: "base64-decoded shell execution",
  },
  {
    pattern: /\beval\b.*\$\(/,
    label: "eval with command substitution",
  },
  {
    pattern: /\bcurl\b.*\|\s*(?:sh\b|bash\b|zsh\b|source\b)/,
    label: "piped remote shell execution",
  },
  {
    pattern: /\bwget\b.*-O\s*-.*\|\s*(?:sh\b|bash\b|zsh\b)/,
    label: "piped remote shell execution via wget",
  },
];

const ALL_RULES: BlockRule[] = [
  ...BLOCKED_COMMANDS,
  ...EXFILTRATION_PATTERNS,
  ...EVASION_PATTERNS,
];

const SANDBOX_TOOLS_WITH_PATHS = new Set([
  "sandbox__read_file",
  "sandbox__write_file",
  "sandbox__list_dir",
]);

function containsPathEscape(
  input: Record<string, unknown>,
  repoDir: string,
): string | null {
  for (const value of Object.values(input)) {
    if (typeof value !== "string") continue;
    const normalized = value.replace(/\/+/g, "/");
    if (normalized.includes("/../") || normalized.startsWith("../")) {
      return "path traversal via ../";
    }
    if (
      normalized.startsWith("/") &&
      !normalized.startsWith(repoDir) &&
      !normalized.startsWith("/tmp/")
    ) {
      return `absolute path outside allowed directories: ${normalized.slice(0, 60)}`;
    }
  }
  return null;
}

/**
 * Prefer the workspace the workflow actually bound. An unbound run still gets
 * scoped against the configured default rather than allowing any path.
 */
function workspaceRoot(ctx: HookContext): string {
  return ctx.environment?.workspace?.repoDir ?? factoryConfig.workspace.repoDir;
}

export const blockDestructiveHook: Hook = {
  name: "block-destructive",
  on: ["tool_call"],
  async handle(event, ctx) {
    if (event.type !== "tool_call") return { action: "continue" };

    if (SANDBOX_TOOLS_WITH_PATHS.has(event.name)) {
      const pathViolation = containsPathEscape(event.input, workspaceRoot(ctx));
      if (pathViolation) {
        return {
          action: "reject",
          reason: `Blocked path escape in ${event.name}: ${pathViolation}`,
        };
      }
    }

    const serialized = JSON.stringify(event.input);
    for (const rule of ALL_RULES) {
      if (rule.pattern.test(serialized)) {
        return {
          action: "reject",
          reason: `Blocked destructive operation: ${rule.label}`,
        };
      }
    }
    return { action: "continue" };
  },
};
