import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@renx/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@renx/model": resolve(__dirname, "packages/model/src/index.ts"),
      "@renx/provider": resolve(__dirname, "packages/provider/src/index.ts"),
      "@renx/provider/glm": resolve(__dirname, "packages/provider/src/glm/index.ts"),
      "@renx/provider/openai": resolve(__dirname, "packages/provider/src/openai/index.ts"),
      "@renx/toolkit": resolve(__dirname, "packages/toolkit/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
  },
});
