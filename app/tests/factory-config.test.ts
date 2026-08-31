import { afterEach, describe, expect, it } from "vitest";
import {
  factoryActors,
  factoryLabel,
  factoryRepository,
} from "../lib/factory-config.js";

afterEach(() => {
  delete process.env.FACTORY_REPO;
  delete process.env.FACTORY_LABEL;
  delete process.env.FACTORY_GITHUB_ACTORS;
});

describe("factory configuration", () => {
  it("parses the one configured repository", () => {
    process.env.FACTORY_REPO = "acme/widgets";
    expect(factoryRepository()).toEqual({
      owner: "acme",
      repo: "widgets",
      fullName: "acme/widgets",
    });
  });

  it("fails fast for missing or malformed repositories", () => {
    expect(() => factoryRepository()).toThrow(/FACTORY_REPO/);
    process.env.FACTORY_REPO = "acme/widgets;rm";
    expect(() => factoryRepository()).toThrow(/owner\/repo/);
  });

  it("uses one default intake label", () => {
    expect(factoryLabel()).toBe("factory");
    process.env.FACTORY_LABEL = "build-it";
    expect(factoryLabel()).toBe("build-it");
  });

  it("requires and normalizes the maintainer actor list", () => {
    expect(() => factoryActors()).toThrow(/FACTORY_GITHUB_ACTORS/);
    process.env.FACTORY_GITHUB_ACTORS = " Alice,BOB ";
    expect(factoryActors()).toEqual(new Set(["alice", "bob"]));
  });
});
