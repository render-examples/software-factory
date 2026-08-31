import { describe, expect, it } from "vitest";
import { StaticModelResolver } from "../models.js";

const tiers = {
  small: "small-model",
  medium: "medium-model",
  large: "large-model",
};

describe("StaticModelResolver", () => {
  it("resolves owned tier keys and preserves literal models", () => {
    const resolver = new StaticModelResolver(tiers);
    expect(resolver.resolve("small")).toEqual({ model: "small-model" });
    expect(resolver.resolve("vendor/model")).toEqual({
      model: "vendor/model",
    });
  });

  it("does not resolve prototype-chain names as tiers", () => {
    const resolver = new StaticModelResolver(tiers);
    expect(resolver.resolve("constructor")).toEqual({
      model: "constructor",
    });
    expect(resolver.resolve("toString")).toEqual({ model: "toString" });
  });
});
