import { describe, expect, it } from "vitest";

import { formatCompactSummary, getCompactPrompt } from "../../src/context/summary-prompt";

describe("summary prompt helpers", () => {
  it("provides copied compact prompt with strict no-tool constraints", () => {
    const prompt = getCompactPrompt();
    expect(prompt).toContain("CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.");
    expect(prompt).toContain(
      "Your task is to create a detailed summary of the conversation so far",
    );
    expect(prompt).toContain("REMINDER: Do NOT call any tools.");
  });

  it("strips analysis and unwraps summary tags", () => {
    const raw = `<analysis>draft</analysis><summary>hello</summary>`;
    expect(formatCompactSummary(raw)).toBe("Summary:\nhello");
  });
});
