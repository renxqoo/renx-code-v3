import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@renx/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@renx/model": resolve(__dirname, "packages/model/src/index.ts"),
      "@renx/provider": resolve(__dirname, "packages/provider/src/index.ts"),
      "@renx/toolkit": resolve(__dirname, "packages/toolkit/src/index.ts"),
      "@renx/agent": resolve(__dirname, "packages/agent/src/index.ts"),
      "@renx/agent-tools": resolve(__dirname, "packages/agent-tools/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
    server: {
      deps: {
        external: ["web-tree-sitter"],
      },
    },
  },
});
