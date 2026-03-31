import { describe, expect, it } from "vitest";

import { GLM_5_1_CODING_PLAN, createGlmProvider } from "../../src/glm";

describe("createGlmProvider", () => {
  it("returns a ready-to-use glm provider using the coding plan defaults", () => {
    const provider = createGlmProvider({
      apiKey: "test-key",
    });

    expect(provider.name).toBe("glm");
    expect(provider.adapter.name).toBe("glm");
  });

  it("exports the glm-5.1 coding plan preset", () => {
    expect(GLM_5_1_CODING_PLAN).toEqual({
      id: "glm-5.1",
      provider: "glm",
      name: "GLM-5.1",
      baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
      endpointPath: "/chat/completions",
      model: "GLM-5.1",
    });
  });
});
