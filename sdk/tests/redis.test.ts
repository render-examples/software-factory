import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const client = {
    isOpen: false,
    on: vi.fn(),
    connect: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
  };
  return { client, createClient: vi.fn(() => client) };
});

vi.mock("redis", () => ({ createClient: state.createClient }));

import { closeKv, kv } from "../redis.js";

beforeEach(() => {
  process.env.REDIS_URL = "redis://example:6379";
  state.client.isOpen = false;
  state.client.on.mockReset();
  state.client.connect.mockReset().mockImplementation(async () => {
    state.client.isOpen = true;
  });
  state.client.close.mockReset().mockImplementation(async () => {
    state.client.isOpen = false;
  });
  state.client.destroy.mockReset();
  state.createClient.mockClear();
});

afterEach(async () => {
  await closeKv();
  delete process.env.REDIS_URL;
});

describe("Key Value client lifecycle", () => {
  it("shares one connection promise across concurrent callers", async () => {
    const [first, second] = await Promise.all([kv(), kv()]);
    expect(first).toBe(second);
    expect(state.createClient).toHaveBeenCalledOnce();
    expect(state.client.connect).toHaveBeenCalledOnce();
  });

  it("registers an error listener before connecting", async () => {
    await kv();
    expect(state.client.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(state.client.on.mock.invocationCallOrder[0]).toBeLessThan(
      state.client.connect.mock.invocationCallOrder[0],
    );
  });

  it("closes the shared client gracefully", async () => {
    await kv();
    await closeKv();
    expect(state.client.close).toHaveBeenCalledOnce();
  });
});
