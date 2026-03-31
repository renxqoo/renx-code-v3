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
});
