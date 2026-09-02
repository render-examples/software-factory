/**
 * Tool-call policy and secret redaction.
 *
 * checkToolCall runs as a Claude `PreToolUse` hook, so it executes before the
 * tool does and can veto it. The sandbox is already ephemeral and scoped to
 * one repository, so treat this as defense in depth rather than the only
 * control.
 */
export { checkToolCall } from "./check.js";
export { PATH_TOOLS, pathEscape } from "./paths.js";
export { RULES, type Rule } from "./rules.js";
export { redactSecrets } from "./secrets.js";
