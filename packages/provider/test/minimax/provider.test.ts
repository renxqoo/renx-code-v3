import { describe, expect, it } from "vitest";

import { createMiniMaxProvider } from "../../src/minimax";

describe("createMiniMaxProvider", () => {
  it("returns a ready-to-use minimax provider with default endpoint", () => {
    const provider = createMiniMaxProvider({ apiKey: "test-key" });

    expect(provider.name).toBe("minimax");
    expect(provider.adapter.name).toBe("minimax");
  });

  it("infers minimax model names", () => {
    const provider = createMiniMaxProvider({ apiKey: "test-key" });

    expect(provider.inferModel?.("minimax-m1")).toBe("minimax-m1");
    expect(provider.inferModel?.("m2-medium")).toBe("m2-medium");
    expect(provider.inferModel?.("abab6.5s-chat")).toBe("abab6.5s-chat");
    expect(provider.inferModel?.("gpt-4o")).toBeNull();
    expect(provider.inferModel?.("qwen-plus")).toBeNull();
  });
});
