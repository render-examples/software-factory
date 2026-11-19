import {
	createModels,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type JsonObject,
} from "@earendil-works/pi-ai";
import type { Harness } from "../../app/harness/index.js";
import { pi } from "../../app/harness/index.js";

export interface TestTurn {
	text?: string;
	calls: { name: string; args: Record<string, unknown>; argumentsError?: string }[];
}

export function scriptedPi(turns: readonly TestTurn[]): Harness {
	const toolCall = (c: TestTurn["calls"][number]) => ({
		...fauxToolCall(c.name, c.args as JsonObject),
		...(c.argumentsError && { argumentsError: c.argumentsError }),
	});
	return fauxPi(
		turns.map((turn) =>
			fauxAssistantMessage([...(turn.text ? [fauxText(turn.text)] : []), ...turn.calls.map(toolCall)], {
				stopReason: turn.calls.length > 0 ? "toolUse" : "stop",
			}),
		),
	);
}

export function fauxPi(responses: FauxResponseStep[], modelId = "scripted"): Harness {
	const stub = fauxProvider({ provider: "scripted", models: [{ id: "scripted", reasoning: false }] });
	stub.setResponses(responses);
	const models = () => {
		const registry = createModels();
		registry.setProvider(stub.provider);
		return registry;
	};
	const model = { ...stub.getModel(), id: modelId };
	return pi({ model, models, thinkingLevel: "off", credential: "SCRIPTED_API_KEY" });
}
