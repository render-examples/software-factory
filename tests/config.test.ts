import { describe, expect, it } from "vitest";
import { validateConfig } from "../app/config/index.js";
import { testConfig } from "./fixtures/config.js";

const withEgress = (egress: string[] | "allow-all") => ({
	...testConfig,
	repos: { "acme/web": { baseBranch: "main", verify: [], egress } },
});

describe("egress configuration", () => {
	it("accepts hostnames, a leftmost wildcard, and allow-all", () => {
		expect(() => validateConfig(withEgress(["registry.npmjs.org", "*.pkg.dev", "proxy.golang.org"]))).not.toThrow();
		expect(() => validateConfig(withEgress("allow-all"))).not.toThrow();
	});

	it.each([
		"https://registry.npmjs.org",
		"registry.npmjs.org/",
		"registry.npmjs.org:443",
		"Registry.npmjs.org",
		"localhost",
		"api.*.example.com",
		"",
	])("rejects %j, naming the repository", (host) => {
		expect(() => validateConfig(withEgress([host]))).toThrow(`factory.config.ts repos["acme/web"]: egress host ${JSON.stringify(host)}`);
	});
});
