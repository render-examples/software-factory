import { describe, expect, it, vi } from "vitest";

const fakeClient = {
	exec: vi.fn(),
	upload: vi.fn(),
	download: vi.fn(),
	terminate: vi.fn(),
	create: vi.fn(),
	get: vi.fn(),
};

vi.mock("../app/sandbox/client.js", () => ({
	api: () => ({ client: fakeClient, ownerId: "tea-test" as const }),
}));

const { Sandbox } = await import("../app/sandbox/sandbox.js");

describe("Sandbox.download", () => {
	it("delegates to the SDK client and returns the raw buffer", async () => {
		const expected = Buffer.from("file contents");
		fakeClient.download.mockResolvedValue({
			data: expected,
			size: expected.length,
			contentType: "application/octet-stream",
		});

		const sandbox = new Sandbox("sbx-dl");
		const result = await sandbox.download("/home/user/repo/out.tar.gz");

		expect(result).toBe(expected);
		expect(fakeClient.download).toHaveBeenCalledWith(
			"sbx-dl",
			"/home/user/repo/out.tar.gz",
			"tea-test",
		);
	});
});
