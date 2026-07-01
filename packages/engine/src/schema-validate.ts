import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

const ajv = new Ajv.default({ allErrors: true, strict: false });

// Compiled validators are cached by schema *identity* (tool `inputSchema` objects
// are stable references), so a hot tool isn't recompiled on every dispatch —
// `ajv.compile` is expensive and unbounded work on adversarial schemas (CR-12).
// A WeakMap keys on the schema object and never grows unbounded (GC-collected
// with the schema).
const validatorCache = new WeakMap<object, ValidateFunction>();

/**
 * Validate tool input against a JSON Schema. Returns `undefined` on success or
 * a human-readable error string on failure. Used in the tool dispatch sequence
 * (step 4) so invalid inputs are returned as an error `tool_result` the model
 * can self-correct from — the loop never crashes.
 */
export function validateToolInput(input: unknown, schema: Record<string, unknown>): string | undefined {
  if (!schema || Object.keys(schema).length === 0) return undefined;
  let validate = validatorCache.get(schema);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      return `Schema compilation error: ${err instanceof Error ? err.message : String(err)}`;
    }
    validatorCache.set(schema, validate);
  }
  const valid = validate(input);
  if (valid) return undefined;
  const errors = (validate.errors ?? [] as ErrorObject[])
    .map((e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? "unknown error"}`)
    .join("; ");
  return `Input validation failed: ${errors}`;
}
