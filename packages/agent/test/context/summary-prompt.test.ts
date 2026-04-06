import { describe, expect, it } from "vitest";

import {
  formatCompactSummary,
  getCompactPrompt,
  getCompactUserSummaryMessage,
  getPartialCompactPrompt,
} from "../../src/context/summary-prompt";

describe("summary prompt helpers", () => {
  it("provides copied compact prompt with strict no-tool constraints", () => {
    const prompt = getCompactPrompt();
    expect(prompt).toContain("CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.");
    expect(prompt).toContain(
      "Your task is to create a detailed summary of the conversation so far",
    );
    expect(prompt).toContain("Here's an example of how your output should be structured:");
    expect(prompt).toContain("REMINDER: Do NOT call any tools.");
  });

  it("provides the partial compact prompt variants", () => {
    const fromPrompt = getPartialCompactPrompt(undefined, "from");
    const upToPrompt = getPartialCompactPrompt(undefined, "up_to");

    expect(fromPrompt).toContain("RECENT portion of the conversation");
    expect(upToPrompt).toContain("placed at the start of a continuing session");
    expect(upToPrompt).toContain("Context for Continuing Work");
  });

  it("strips analysis and unwraps summary tags", () => {
    const raw = `<analysis>draft</analysis><summary>hello</summary>`;
    expect(formatCompactSummary(raw)).toBe("Summary:\nhello");
  });

  it("builds the Claude-style compact continuation message", () => {
    const message = getCompactUserSummaryMessage(
      "<summary>restored compact summary</summary>",
      true,
      "/tmp/transcript.md",
      true,
    );

    expect(message).toContain(
      "This session is being continued from a previous conversation that ran out of context.",
    );
    expect(message).toContain("If you need specific details from before compaction");
    expect(message).toContain("Recent messages are preserved verbatim.");
    expect(message).toContain("Continue the conversation from where it left off");
  });
});
