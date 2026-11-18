import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "../../util/index.js";

export const SUBMIT_TOOL = "submit";
export const MAX_SUBMIT_ATTEMPTS = 3;

type JsonOutputSchema = Record<string, unknown>;

export function outputSchemaProblem(schema: JsonOutputSchema): string | undefined {
	if (schema.type !== "object") return 'output_schema must have type "object" at its root';
	const props = schema.properties;
	if (typeof props !== "object" || props === null || Array.isArray(props)) {
		return "output_schema must have a properties object at its root";
	}
	try {
		Value.Check(schema as TSchema, {});
	} catch (err) {
		return `output_schema is not a usable JSON Schema: ${errorMessage(err)}`;
	}
	return undefined;
}

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

export type SubmitCheck = { ok: true; checked: unknown } | { ok: false; message: string; exhausted?: string };

export class Submission {
	#accepted: { output: unknown } | undefined;
	#rejected = 0;

	constructor(private readonly schema: JsonOutputSchema) {}

	get accepted(): { output: unknown } | undefined {
		return this.#accepted;
	}

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
		const fields = args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args) : [];
		const names =
			fields
				.slice(0, 20)
				.map((f) => f.slice(0, 40))
				.join(", ") || "none";
		const exhausted = `${SUBMIT_TOOL} was rejected ${this.#rejected} times; last: ${problems.slice(0, 5).join("; ")}; submitted fields: ${names}`;
		return { ok: false, message, exhausted };
	}

	accept(output: unknown): boolean {
		if (this.#accepted) return false;
		this.#accepted = { output };
		return true;
	}
}
