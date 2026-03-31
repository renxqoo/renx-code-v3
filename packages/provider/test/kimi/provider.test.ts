import { describe, expect, it } from "vitest";

import { createKimiProvider } from "../../src/kimi";

describe("createKimiProvider", () => {
  it("returns a ready-to-use kimi provider with default endpoint", () => {
    const provider = createKimiProvider({ apiKey: "test-key" });

    expect(provider.name).toBe("kimi");
    expect(provider.adapter.name).toBe("kimi");
  });

  it("infers moonshot and kimi model names", () => {
    const provider = createKimiProvider({ apiKey: "test-key" });

    expect(provider.inferModel?.("moonshot-v1-128k")).toBe("moonshot-v1-128k");
    expect(provider.inferModel?.("kimi-latest")).toBe("kimi-latest");
    expect(provider.inferModel?.("gpt-4o")).toBeNull();
    expect(provider.inferModel?.("glm-5.1")).toBeNull();
  });

  it("accepts custom baseURL", () => {
    const provider = createKimiProvider({
      apiKey: "test-key",
      baseURL: "https://custom.api.cn/v1",
    });

    expect(provider.name).toBe("kimi");
  });
});
