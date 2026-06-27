export class LoadError extends Error {
  readonly code: string;
  readonly detail?: Record<string, unknown>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "LoadError";
    this.code = code;
    this.detail = detail;
  }
}

export const ERR_UNKNOWN_FIELD = "UNKNOWN_FIELD";
export const ERR_EMPTY_BODY = "EMPTY_BODY";
export const ERR_DUPLICATE_KEY = "DUPLICATE_KEY";
export const ERR_TOOL_NOT_FOUND = "TOOL_NOT_FOUND";
export const ERR_TOOL_NAME_NOT_FOUND = "TOOL_NAME_NOT_FOUND";
export const ERR_SKILL_NOT_FOUND = "SKILL_NOT_FOUND";
export const ERR_UNKNOWN_TIER = "UNKNOWN_TIER";
export const ERR_UNROUTABLE_MODEL = "UNROUTABLE_MODEL";
export const ERR_INVALID_PLAN = "INVALID_PLAN";
export const ERR_INVALID_OUTPUT = "INVALID_OUTPUT";
export const ERR_SUBAGENT_NOT_FOUND = "SUBAGENT_NOT_FOUND";
export const ERR_SUBAGENT_SELF_REF = "SUBAGENT_SELF_REF";
export const ERR_RUNNER_NOT_FOUND = "RUNNER_NOT_FOUND";
export const ERR_APPROVAL_NOT_IN_TOOLS = "APPROVAL_NOT_IN_TOOLS";
export const ERR_INVALID_BUDGET = "INVALID_BUDGET";
export const ERR_RESERVED_TOOL_NAME = "RESERVED_TOOL_NAME";
export const ERR_FRONTMATTER_VALIDATION = "FRONTMATTER_VALIDATION";
export const ERR_LIKELY_AGENTS_DIR = "LIKELY_AGENTS_DIR";
