import {
	type Api,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Model,
	type MutableModels,
} from "@earendil-works/pi-ai";
import type { TestTurn } from "../core/protocol.js";

const TEST_STUB_MODEL = "test-stub";

/**
 * Adds a provider that plays `turns` instead of calling a model. It carries the requested model's prices, so the
 * runner can cost the stub's token estimates.
 */
export function registerTestStubModel(models: MutableModels, turns: readonly TestTurn[], priced: Model<Api>): Model<Api> {
	const { input, output, cacheRead, cacheWrite } = priced.cost;
	const stub = fauxProvider({
		provider: TEST_STUB_MODEL,
		models: [{ id: TEST_STUB_MODEL, reasoning: false, cost: { input, output, cacheRead, cacheWrite } }],
	});
	models.setProvider(stub.provider);
	stub.setResponses(turns.map(toResponse));
	return stub.getModel() as Model<Api>;
}

function toResponse(turn: TestTurn): FauxResponseStep {
	const content = [...(turn.text ? [fauxText(turn.text)] : []), ...turn.calls.map((c) => fauxToolCall(c.name, c.args))];
	return fauxAssistantMessage(content, { stopReason: turn.calls.length > 0 ? "toolUse" : "stop" });
}
