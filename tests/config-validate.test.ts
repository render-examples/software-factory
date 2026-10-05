import { describe, expect, it } from "vitest";
import { validateConfig } from "../app/config/validate.js";

describe("validateConfig", () => {
	it("passes on the default factory config", () => {
		expect(() => validateConfig()).not.toThrow();
	});
});
