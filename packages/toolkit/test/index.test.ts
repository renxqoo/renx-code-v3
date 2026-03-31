import { describe, expect, it } from "vitest";

import { renderBanner, renderTaskBanner } from "../src/index";

describe("toolkit banner renderer", () => {
  it("renders a centered banner", () => {
    expect(renderBanner({ label: "renx", width: 12 })).toBe("=== renx ===");
  });

  it("never truncates long labels", () => {
    expect(renderBanner({ label: "monorepo-setup", width: 4 })).toBe(" monorepo-setup ");
  });

  it("can use helpers from @renx/core", () => {
    expect(renderTaskBanner("Ship ci")).toBe("====== ship-ci: Ship ci ======");
  });
});
