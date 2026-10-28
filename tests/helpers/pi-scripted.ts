import { type FauxProviderHandle, type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Harness } from "../../app/harness/index.js";
import { pi } from "../../app/harness/index.js";
import { createModels } from "../../app/runner/pi/driver.js";
import type { TestTurn } from "./scripted-harness.js";

/** The pi harness with Pi's fake provider as its model, playing `turns`: a model like any other, to the harness. */
export function scriptedPi(turns: readonly TestTurn[]): Harness {
	return fauxPi(
		turns.map((turn) =>
			fauxAssistantMessage([...(turn.text ? [fauxText(turn.text)] : []), ...turn.calls.map((c) => fauxToolCall(c.name, c.args))], {
				stopReason: turn.calls.length > 0 ? "toolUse" : "stop",
			}),
		),
	).harness;
}

/** The pi harness on Pi's fake provider, answering each model request with the next of `responses`. */
export function fauxPi(responses: FauxResponseStep[], modelId = "scripted"): { harness: Harness; stub: FauxProviderHandle } {
	const stub = fauxProvider({ provider: "scripted", models: [{ id: "scripted", reasoning: false }] });
	stub.setResponses(responses);
	const models = () => {
		const registry = createModels();
		registry.setProvider(stub.provider);
		return registry;
	};
	const model = { ...stub.getModel(), id: modelId };
	return { harness: pi({ model, models, thinkingLevel: "off", credential: "SCRIPTED_API_KEY" }), stub };
}
