import { describe, expect, it } from "vitest";

import { createOpenAIProvider } from "../../src/openai";

describe("createOpenAIProvider", () => {
  it("returns a ready-to-use provider registration", () => {
    const provider = createOpenAIProvider({
      apiKey: "test-key",
    });

    expect(provider.name).toBe("openai");
    expect(provider.adapter.name).toBe("openai");
  });

  it("infers gpt model names", () => {
    const provider = createOpenAIProvider({ apiKey: "test-key" });

    expect(provider.inferModel?.("gpt-4o")).toBe("gpt-4o");
    expect(provider.inferModel?.("o3-mini")).toBe("o3-mini");
    expect(provider.inferModel?.("claude-sonnet")).toBeNull();
  });
});
