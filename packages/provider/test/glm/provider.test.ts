import { describe, expect, it } from "vitest";

import { createGlmProvider } from "../../src/glm";

describe("createGlmProvider", () => {
  it("returns a ready-to-use glm provider with default endpoint", () => {
    const provider = createGlmProvider({ apiKey: "test-key" });

    expect(provider.name).toBe("glm");
    expect(provider.adapter.name).toBe("glm");
  });

  it("infers and normalizes glm model names", () => {
    const provider = createGlmProvider({ apiKey: "test-key" });

    expect(provider.inferModel?.("glm-5.1")).toBe("GLM-5.1");
    expect(provider.inferModel?.("gpt-4o")).toBeNull();
  });
});
