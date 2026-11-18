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

/** One scripted model turn: optional text, then tool calls in order. A turn without calls ends the conversation. */
export interface TestTurn {
	text?: string;
	calls: { name: string; args: Record<string, unknown> }[];
}

/** The pi harness with Pi's fake provider as its model, playing `turns`: a model like any other, to the harness. */
export function scriptedPi(turns: readonly TestTurn[]): Harness {
	return fauxPi(
		turns.map((turn) =>
			fauxAssistantMessage([...(turn.text ? [fauxText(turn.text)] : []), ...turn.calls.map((c) => fauxToolCall(c.name, c.args as JsonObject))], {
				stopReason: turn.calls.length > 0 ? "toolUse" : "stop",
			}),
		),
	);
}

/** The pi harness on Pi's fake provider, answering each model request with the next of `responses`. */
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
