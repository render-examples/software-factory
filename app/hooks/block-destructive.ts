/**
 * Block-destructive hook — vetoes tool calls containing dangerous commands.
 */
import type { Hook } from "../../sdk/hooks.js";

const BLOCKED_PATTERNS = [
  "rm -rf /",
  "rm -rf ~",
  "git push --force",
  "git push -f",
  "DROP TABLE",
  "DROP DATABASE",
  "TRUNCATE TABLE",
  "mkfs.",
  "dd if=",
  "> /dev/sda",
];

export const blockDestructiveHook: Hook = {
  name: "block-destructive",
  on: ["tool_call"],
  async handle(event, _ctx) {
    if (event.type !== "tool_call") return { action: "continue" };
    const serialized = JSON.stringify(event.input).toLowerCase();
    for (const pattern of BLOCKED_PATTERNS) {
      if (serialized.includes(pattern.toLowerCase())) {
        return {
          action: "reject",
          reason: `Blocked destructive operation: "${pattern}"`,
        };
      }
    }
    return { action: "continue" };
  },
};
