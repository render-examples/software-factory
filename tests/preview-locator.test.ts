import { describe, expect, it } from "vitest";
import type { PreviewLocator, PreviewStatus } from "../app/preview/types.js";

function fakeLocator(statuses: PreviewStatus[]): PreviewLocator {
	let call = 0;
	return {
		async locate(): Promise<PreviewStatus> {
			return statuses[Math.min(call++, statuses.length - 1)];
		},
	};
}

describe("preview locator states", () => {
	it("returns not_configured", async () => {
		const locator = fakeLocator([{ state: "not_configured" }]);
		const status = await locator.locate({
			serviceName: "web",
			headSha: "abc",
			prNumber: 1,
		});
		expect(status.state).toBe("not_configured");
	});

	it("returns pending then live", async () => {
		const locator = fakeLocator([
			{ state: "pending", detail: "Building" },
			{ state: "live", url: "https://preview.example.com" },
		]);

		const first = await locator.locate({
			serviceName: "web",
			headSha: "abc",
			prNumber: 1,
		});
		expect(first.state).toBe("pending");

		const second = await locator.locate({
			serviceName: "web",
			headSha: "abc",
			prNumber: 1,
		});
		expect(second.state).toBe("live");
		if (second.state === "live") {
			expect(second.url).toBe("https://preview.example.com");
		}
	});

	it("returns failed", async () => {
		const locator = fakeLocator([{ state: "failed", detail: "Build failed" }]);
		const status = await locator.locate({
			serviceName: "web",
			headSha: "abc",
			prNumber: 1,
		});
		expect(status.state).toBe("failed");
		if (status.state === "failed") {
			expect(status.detail).toBe("Build failed");
		}
	});
});
