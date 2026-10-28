import { vi } from "vitest";

// Mock the deployment file, not app/config: repository resolution and permission checks remain real.
vi.mock("../factory.config.js", async () => ({ default: (await import("./fixtures/config.js")).testConfig }));
