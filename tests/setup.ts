import { vi } from "vitest";

vi.mock("../factory.config.js", async () => ({ default: (await import("./fixtures/config.js")).testConfig }));
