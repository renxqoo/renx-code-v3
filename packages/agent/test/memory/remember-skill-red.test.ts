import { describe, expect, it } from "vitest";

import { buildRememberPrompt, REMEMBER_SKILL_NAME } from "../../src/memory/remember-skill";

describe("remember skill", () => {
  describe("buildRememberPrompt", () => {
    it("includes memory review goal", () => {
      const prompt = buildRememberPrompt();
      expect(prompt).toContain("Memory Review");
      expect(prompt).toContain("review");
    });

    it("includes 4-step structure", () => {
      const prompt = buildRememberPrompt();
      expect(prompt).toContain("Gather all memory layers");
      expect(prompt).toContain("Classify each auto-memory entry");
      expect(prompt).toContain("Identify cleanup opportunities");
      expect(prompt).toContain("Present the report");
    });

    it("includes destination classification table", () => {
      const prompt = buildRememberPrompt();
      expect(prompt).toContain("CLAUDE.md");
      expect(prompt).toContain("CLAUDE.local.md");
      expect(prompt).toContain("Stay in auto-memory");
    });

    it("includes rules about not modifying without approval", () => {
      const prompt = buildRememberPrompt();
      expect(prompt).toContain("Do NOT modify files without explicit user approval");
    });

    it("appends additional context from user", () => {
      const prompt = buildRememberPrompt("Focus on feedback memories");
      expect(prompt).toContain("Additional context from user");
      expect(prompt).toContain("Focus on feedback memories");
    });

    it("works without additional context", () => {
      const prompt = buildRememberPrompt();
      expect(prompt).not.toContain("Additional context from user");
    });
  });

  describe("REMEMBER_SKILL_NAME", () => {
    it("is 'remember'", () => {
      expect(REMEMBER_SKILL_NAME).toBe("remember");
    });
  });
});
