import type { TSchema } from "typebox";
import { Value } from "typebox/value";

export const SUBMIT_TOOL = "submit";
export const MAX_SUBMIT_ATTEMPTS = 3;

type JsonOutputSchema = Record<string, unknown>;

/**
 * Why `schema` can't be a submit tool's parameters, or undefined if it can. Pi's Anthropic adapter sends only
 * the top-level `properties` and `required`, so the root must be a plain object schema, not a union or a ref.
 */
export function outputSchemaProblem(schema: JsonOutputSchema): string | undefined {
	if (schema.type !== "object") return 'output_schema must have type "object" at its root';
	const props = schema.properties;
	if (typeof props !== "object" || props === null || Array.isArray(props)) {
		return "output_schema must have a properties object at its root";
	}
	try {
		Value.Check(schema as TSchema, {});
	} catch (err) {
		return `output_schema is not a usable JSON Schema: ${err instanceof Error ? err.message : String(err)}`;
	}
	return undefined;
}

/** The submit tool's parameters as the model sees them: the output schema without JSON Schema metadata. */
export function submitParameters(schema: JsonOutputSchema): JsonOutputSchema {
	const { $schema: _schema, $id: _id, ...rest } = schema;
	return rest;
}

export function submitDescription(schema: JsonOutputSchema): string {
	const what = typeof schema.description === "string" && schema.description ? ` ${schema.description}` : "";
	return (
		`Submit your final output.${what} Call it exactly once, as your final action, on its own. The arguments are ` +
		"checked against the schema; a rejected submission records nothing, so fix every listed problem and call it " +
		`again (${MAX_SUBMIT_ATTEMPTS} attempts in total).`
	);
}

export const SUBMIT_ACCEPTED = "Submission recorded. You are done.";
export const SUBMIT_DUPLICATE = "Already submitted; this call was ignored.";

export type SubmitCheck =
	| { ok: true; checked: unknown }
	/** `exhausted` is set on the last allowed attempt: the run must stop with `invalid_submission` and this message. */
	| { ok: false; message: string; exhausted?: string };

/**
 * One run's submission: checks each attempt against the output JSON Schema with TypeBox, which validates plain
 * JSON Schema (including what `z.toJSONSchema` emits), and counts rejections. A usability check so the model can
 * fix its submission: the host revalidates the accepted output with the agent's Zod schema, and that check is
 * authoritative. Every harness's submit tool goes through this.
 */
export class Submission {
	#accepted: { output: unknown } | undefined;
	#rejected = 0;

	constructor(private readonly schema: JsonOutputSchema) {}

	get accepted(): { output: unknown } | undefined {
		return this.#accepted;
	}

	/** Checks `args` without recording them. The checked copy is what `accept` should record. */
	check(args: unknown): SubmitCheck {
		if (Value.Check(this.schema as TSchema, args)) return { ok: true, checked: structuredClone(args) };
		const found = [...Value.Errors(this.schema as TSchema, args)].map((e) => `${e.instancePath || "(root)"}: ${e.message}`);
		const problems = found.length > 0 ? [...new Set(found)] : ["(root): does not match the output schema"];
		this.#rejected++;
		const remaining = MAX_SUBMIT_ATTEMPTS - this.#rejected;
		const message =
			`${SUBMIT_TOOL} rejected (attempt ${this.#rejected} of ${MAX_SUBMIT_ATTEMPTS}); nothing was recorded. ` +
			(remaining > 0 ? "Fix every problem below and call it again:\n" : "No attempts remain:\n") +
			problems.map((p) => `- ${p}`).join("\n");
		if (remaining > 0) return { ok: false, message };
		// Schema paths, rule names, and field names only: TypeBox's errors don't quote the submitted values.
		const fields = args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args) : [];
		const names =
			fields
				.slice(0, 20)
				.map((f) => f.slice(0, 40))
				.join(", ") || "none";
		const exhausted = `${SUBMIT_TOOL} was rejected ${this.#rejected} times; last: ${problems.slice(0, 5).join("; ")}; submitted fields: ${names}`;
		return { ok: false, message, exhausted };
	}

	/** Records the first accepted output; false when one was already recorded. */
	accept(output: unknown): boolean {
		if (this.#accepted) return false;
		this.#accepted = { output };
		return true;
	}
}
