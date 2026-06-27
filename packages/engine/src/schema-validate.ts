import Ajv, { type ErrorObject } from "ajv";

const ajv = new Ajv.default({ allErrors: true, strict: false });

/**
 * Validate tool input against a JSON Schema. Returns `undefined` on success or
 * a human-readable error string on failure. Used in the tool dispatch sequence
 * (step 4) so invalid inputs are returned as an error `tool_result` the model
 * can self-correct from — the loop never crashes.
 */
export function validateToolInput(input: unknown, schema: Record<string, unknown>): string | undefined {
  if (!schema || Object.keys(schema).length === 0) return undefined;
  const validate = ajv.compile(schema);
  const valid = validate(input);
  if (valid) return undefined;
  const errors = (validate.errors ?? [] as ErrorObject[])
    .map((e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? "unknown error"}`)
    .join("; ");
  return `Input validation failed: ${errors}`;
}
