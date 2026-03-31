import { describe, expect, it } from "vitest";

import { createQwenProvider } from "../../src/qwen";

describe("createQwenProvider", () => {
  it("returns a ready-to-use qwen provider with default endpoint", () => {
    const provider = createQwenProvider({ apiKey: "test-key" });

    expect(provider.name).toBe("qwen");
    expect(provider.adapter.name).toBe("qwen");
  });

  it("infers qwen model names", () => {
    const provider = createQwenProvider({ apiKey: "test-key" });

    expect(provider.inferModel?.("qwen-plus")).toBe("qwen-plus");
    expect(provider.inferModel?.("qwen-max")).toBe("qwen-max");
    expect(provider.inferModel?.("qwen-turbo")).toBe("qwen-turbo");
    expect(provider.inferModel?.("gpt-4o")).toBeNull();
    expect(provider.inferModel?.("glm-5.1")).toBeNull();
  });
});
