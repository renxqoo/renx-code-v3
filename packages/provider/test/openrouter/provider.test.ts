import { describe, expect, it } from "vitest";

import { createOpenRouterProvider } from "../../src/openrouter";

describe("createOpenRouterProvider", () => {
  it("returns a ready-to-use openrouter provider with default endpoint", () => {
    const provider = createOpenRouterProvider({ apiKey: "test-key" });

    expect(provider.name).toBe("openrouter");
    expect(provider.adapter.name).toBe("openrouter");
  });

  it("passes through all model names (openrouter accepts any model)", () => {
    const provider = createOpenRouterProvider({ apiKey: "test-key" });

    expect(provider.inferModel?.("anthropic/claude-sonnet-4-20250514")).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
    expect(provider.inferModel?.("google/gemini-2.5-pro")).toBe("google/gemini-2.5-pro");
    expect(provider.inferModel?.("meta-llama/llama-3-70b-instruct")).toBe(
      "meta-llama/llama-3-70b-instruct",
    );
  });
});
