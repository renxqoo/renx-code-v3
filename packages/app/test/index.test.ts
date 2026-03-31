import { describe, expect, it } from "vitest";

import { createAppOutput } from "../src/app";

describe("app entry", () => {
  it("renders output from workspace dependencies", () => {
    expect(createAppOutput()).toBe("====== ship-ci: Ship ci ======");
  });
});
