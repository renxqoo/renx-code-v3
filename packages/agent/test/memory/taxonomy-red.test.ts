import { describe, expect, it } from "vitest";

import { buildMemoryTaxonomyPrompt, parseMemoryTaxonomyType } from "../../src/memory";

describe("memory taxonomy", () => {
  it("parses supported taxonomy types and rejects unknown types", () => {
    expect(parseMemoryTaxonomyType("user")).toBe("user");
    expect(parseMemoryTaxonomyType("feedback")).toBe("feedback");
    expect(parseMemoryTaxonomyType("project")).toBe("project");
    expect(parseMemoryTaxonomyType("reference")).toBe("reference");
    expect(parseMemoryTaxonomyType("random")).toBeUndefined();
  });

  it("builds a taxonomy prompt with save, recall, and trust guidance", () => {
    const prompt = buildMemoryTaxonomyPrompt({ mode: "combined" });

    expect(prompt).toContain("## Types of memory");
    expect(prompt).toContain("feedback");
    expect(prompt).toContain("## What NOT to save in memory");
    expect(prompt).toContain("## When to access memories");
    expect(prompt).toContain("## Before recommending from memory");
  });
});
