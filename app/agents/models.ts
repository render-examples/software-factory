import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { pi } from "../harness/index.js";

export const piSonnet = pi({ model: getBuiltinModel("anthropic", "claude-sonnet-5") });
export const piOpus = pi({ model: getBuiltinModel("anthropic", "claude-opus-5") });
