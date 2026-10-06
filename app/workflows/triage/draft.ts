import type { TaskContext } from "@renderinc/sdk/workflows";
import { z } from "zod";
import {
	specSchema,
	specNotesSchema,
	validateSpec,
	type Spec,
	type SpecNotes,
	type SpecValidation,
} from "../../contracts/index.js";
import type { IssueComment } from "../../github/index.js";
import { workItem } from "../../format/index.js";
import { specWriterTask } from "../../tasks/index.js";
import { agentJson } from "../agent-json.js";

const specWriterOutputSchema = z.object({
	spec: specSchema,
	notes: specNotesSchema,
	changeSummary: z.string().optional(),
});

export interface DraftInput {
	issue: { number: number; title: string; body: string };
	comments: IssueComment[];
	findings: string;
	relevantPaths: string[];
	previousSpec?: Spec;
	previousNotes?: SpecNotes;
	sandboxId: string;
	runId: string;
	existingPaths?: ReadonlySet<string>;
}

export interface DraftResult {
	spec: Spec;
	notes: SpecNotes;
	validation: SpecValidation;
	changeSummary?: string;
}

export async function draft(
	ctx: TaskContext,
	input: DraftInput,
): Promise<DraftResult> {
	const sections: string[] = [];

	sections.push(
		workItem(input.issue as Parameters<typeof workItem>[0], input.comments),
	);

	sections.push("\n## Triage Findings\n");
	sections.push(input.findings);
	sections.push(`\nRelevant paths: ${input.relevantPaths.join(", ")}`);

	if (input.previousSpec) {
		sections.push("\n## Previous Specification (revise this)\n");
		sections.push(JSON.stringify(input.previousSpec, null, 2));
	}

	if (input.previousNotes) {
		sections.push("\n## Previous Notes\n");
		sections.push(input.previousNotes.findings);
	}

	const message = sections.join("\n");

	const call = async (msg: string) => {
		const result = await ctx.run(specWriterTask, {
			runId: input.runId,
			message: msg,
			sandboxId: input.sandboxId,
		});
		return result as string;
	};

	const output = await agentJson(
		call,
		specWriterOutputSchema,
		message,
		"draft",
	);

	const validation = validateSpec(output.spec, input.existingPaths);
	if (validation.errors.length > 0) {
		throw new Error(`Spec validation failed: ${validation.errors.join("; ")}`);
	}

	return {
		spec: output.spec,
		notes: output.notes,
		validation,
		changeSummary: output.changeSummary,
	};
}
