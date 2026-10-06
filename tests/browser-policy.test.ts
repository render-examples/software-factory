import { describe, expect, it } from "vitest";
import { checkBrowserNavigation } from "../app/policy/browser.js";

describe("checkBrowserNavigation", () => {
	const origins = ["http://localhost:3000", "https://preview.example.com"];

	it("allows navigation to an allowed origin", () => {
		expect(
			checkBrowserNavigation("http://localhost:3000/path", origins),
		).toBeNull();
		expect(
			checkBrowserNavigation("https://preview.example.com/app", origins),
		).toBeNull();
	});

	it("blocks navigation to a disallowed origin", () => {
		const result = checkBrowserNavigation("https://evil.test/steal", origins);
		expect(result).toContain("not allowed");
		expect(result).toContain("https://evil.test");
	});

	it("blocks navigation when no origins configured", () => {
		expect(checkBrowserNavigation("http://localhost:3000", [])).toContain(
			"No allowed origins",
		);
	});

	it("rejects invalid URLs", () => {
		expect(checkBrowserNavigation("not-a-url", origins)).toContain(
			"Invalid URL",
		);
	});

	it("blocks cross-origin redirects (different port)", () => {
		expect(
			checkBrowserNavigation("http://localhost:4000/redir", origins),
		).toContain("not allowed");
	});

	it("blocks different protocol on same host", () => {
		expect(
			checkBrowserNavigation("https://localhost:3000/secure", origins),
		).toContain("not allowed");
	});
});
