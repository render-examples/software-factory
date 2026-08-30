/**
 * Redact-secrets hook — strips secret-like patterns from agent output.
 */
import type { Hook } from "../../sdk/hooks.js";

const SECRET_PATTERNS = [
  /\b(sk-ant-api\S{10,})\b/g,
  /\b(ghp_\S{10,})\b/g,
  /\b(ghs_\S{10,})\b/g,
  /\b(github_pat_\S{10,})\b/g,
  /\b(xoxb-\S{10,})\b/g,
  /\b(xoxp-\S{10,})\b/g,
  /\b(rnd_\S{10,})\b/g,
  /\b(AKIA\S{12,})\b/g,
  /\b(sk-\S{20,})\b/g,
];

function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

export const redactSecretsHook: Hook = {
  name: "redact-secrets",
  on: ["result", "text", "tool_result"],
  async handle(event, _ctx) {
    switch (event.type) {
      case "result":
        return {
          action: "continue",
          event: { ...event, result: redact(event.result) },
        };
      case "text":
        return {
          action: "continue",
          event: { ...event, text: redact(event.text) },
        };
      case "tool_result":
        return {
          action: "continue",
          event: { ...event, content: redact(event.content) },
        };
      default:
        return { action: "continue" };
    }
  },
};
