import type { TaskContext } from "@renderinc/sdk/workflows";
import {
	triageDecisionSchema,
	type TriageDecision,
} from "../../contracts/index.js";
import type { Spec, SpecNotes } from "../../contracts/index.js";
import type { IssueComment } from "../../github/index.js";
import { workItem } from "../../format/index.js";
import { triageTask } from "../../tasks/index.js";
import { agentJson } from "../agent-json.js";

export interface AssessInput {
	issue: { number: number; title: string; body: string };
	comments: IssueComment[];
	currentSpec?: Spec;
	currentNotes?: SpecNotes;
	sandboxId: string;
	runId: string;
}

export async function assess(
	ctx: TaskContext,
	input: AssessInput,
): Promise<TriageDecision> {
	const sections: string[] = [];

	sections.push(
		workItem(input.issue as Parameters<typeof workItem>[0], input.comments),
	);

	if (input.currentSpec) {
		sections.push("\n## Current Specification\n");
		sections.push(JSON.stringify(input.currentSpec, null, 2));
	}

	if (input.currentNotes) {
		sections.push("\n## Previous Round Notes\n");
		sections.push(`Findings: ${input.currentNotes.findings}`);
		sections.push(
			`Relevant paths: ${input.currentNotes.relevantPaths.join(", ")}`,
		);
	}

	const message = sections.join("\n");

	const call = async (msg: string) => {
		const result = await ctx.run(triageTask, {
			runId: input.runId,
			message: msg,
			sandboxId: input.sandboxId,
		});
		return result as string;
	};

	return agentJson(call, triageDecisionSchema, message, "assess");
}
