import { describe, expect, it } from "vitest";

import {
  MEMORY_TYPES,
  parseMemoryType,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
} from "../../src/memory/prompts/types-section";
import { WHAT_NOT_TO_SAVE_SECTION } from "../../src/memory/prompts/what-not-to-save";
import {
  WHEN_TO_ACCESS_SECTION,
  MEMORY_DRIFT_CAVEAT,
} from "../../src/memory/prompts/when-to-access";
import { TRUSTING_RECALL_SECTION } from "../../src/memory/prompts/trusting-recall";
import { MEMORY_FRONTMATTER_EXAMPLE } from "../../src/memory/prompts/frontmatter-example";
import { buildExtractAutoOnlyPrompt } from "../../src/memory/prompts/extraction";
import { buildConsolidationPrompt } from "../../src/memory/prompts/dream";
import {
  buildMemoryLines,
  buildMemoryPrompt,
  DIR_EXISTS_GUIDANCE,
  DIRS_EXIST_GUIDANCE,
} from "../../src/memory/prompts/builder";

describe("prompts", () => {
  describe("TYPES_SECTION_COMBINED", () => {
    it("contains all four memory types", () => {
      const text = TYPES_SECTION_COMBINED.join("\n");
      expect(text).toContain("<name>user</name>");
      expect(text).toContain("<name>feedback</name>");
      expect(text).toContain("<name>project</name>");
      expect(text).toContain("<name>reference</name>");
    });

    it("includes <scope> tags for combined mode", () => {
      const text = TYPES_SECTION_COMBINED.join("\n");
      expect(text).toContain("<scope>");
      expect(text).toContain("</scope>");
    });

    it("includes team/private qualifiers in examples", () => {
      const text = TYPES_SECTION_COMBINED.join("\n");
      expect(text).toContain("team");
      expect(text).toContain("private");
    });
  });

  describe("TYPES_SECTION_INDIVIDUAL", () => {
    it("contains all four memory types", () => {
      const text = TYPES_SECTION_INDIVIDUAL.join("\n");
      expect(text).toContain("<name>user</name>");
      expect(text).toContain("<name>feedback</name>");
      expect(text).toContain("<name>project</name>");
      expect(text).toContain("<name>reference</name>");
    });

    it("does not include <scope> tags", () => {
      const text = TYPES_SECTION_INDIVIDUAL.join("\n");
      expect(text).not.toContain("<scope>");
    });

    it("includes examples with plain save format", () => {
      const text = TYPES_SECTION_INDIVIDUAL.join("\n");
      expect(text).toContain("[saves user memory:");
      expect(text).toContain("[saves feedback memory:");
    });
  });

  describe("MEMORY_TYPES", () => {
    it("lists the four canonical types", () => {
      expect(MEMORY_TYPES).toEqual(["user", "feedback", "project", "reference"]);
    });
  });

  describe("parseMemoryType", () => {
    it("parses valid types", () => {
      expect(parseMemoryType("user")).toBe("user");
      expect(parseMemoryType("feedback")).toBe("feedback");
      expect(parseMemoryType("project")).toBe("project");
      expect(parseMemoryType("reference")).toBe("reference");
    });

    it("returns undefined for invalid types", () => {
      expect(parseMemoryType("invalid")).toBeUndefined();
      expect(parseMemoryType("")).toBeUndefined();
      expect(parseMemoryType(42)).toBeUndefined();
      expect(parseMemoryType(undefined)).toBeUndefined();
    });
  });

  describe("WHAT_NOT_TO_SAVE_SECTION", () => {
    it("excludes code patterns and conventions", () => {
      const text = WHAT_NOT_TO_SAVE_SECTION.join("\n");
      expect(text).toContain("Code patterns");
      expect(text).toContain("conventions");
    });

    it("excludes git history", () => {
      const text = WHAT_NOT_TO_SAVE_SECTION.join("\n");
      expect(text).toContain("git log");
    });

    it("excludes ephemeral task details", () => {
      const text = WHAT_NOT_TO_SAVE_SECTION.join("\n");
      expect(text).toContain("Ephemeral");
    });

    it("includes explicit-save gate", () => {
      const text = WHAT_NOT_TO_SAVE_SECTION.join("\n");
      expect(text).toContain("surprising");
    });
  });

  describe("WHEN_TO_ACCESS_SECTION", () => {
    it("includes mandatory access on explicit ask", () => {
      const text = WHEN_TO_ACCESS_SECTION.join("\n");
      expect(text).toContain("MUST access memory");
    });

    it("includes ignore instruction", () => {
      const text = WHEN_TO_ACCESS_SECTION.join("\n");
      expect(text).toContain("ignore");
      expect(text).toContain("MEMORY.md were empty");
    });

    it("includes MEMORY_DRIFT_CAVEAT", () => {
      const text = WHEN_TO_ACCESS_SECTION.join("\n");
      expect(text).toContain("stale");
    });
  });

  describe("MEMORY_DRIFT_CAVEAT", () => {
    it("instructs to verify before answering", () => {
      expect(MEMORY_DRIFT_CAVEAT).toContain("verify");
      expect(MEMORY_DRIFT_CAVEAT).toContain("trust what you observe now");
    });
  });

  describe("TRUSTING_RECALL_SECTION", () => {
    it('has "Before recommending" header', () => {
      expect(TRUSTING_RECALL_SECTION[0]).toContain("Before recommending");
    });

    it("instructs to check file paths exist", () => {
      const text = TRUSTING_RECALL_SECTION.join("\n");
      expect(text).toContain("check the file exists");
    });

    it("instructs to grep for functions/flags", () => {
      const text = TRUSTING_RECALL_SECTION.join("\n");
      expect(text).toContain("grep for it");
    });
  });

  describe("MEMORY_FRONTMATTER_EXAMPLE", () => {
    it("includes frontmatter delimiters", () => {
      const text = MEMORY_FRONTMATTER_EXAMPLE.join("\n");
      expect(text).toContain("---");
    });

    it("includes name and description fields", () => {
      const text = MEMORY_FRONTMATTER_EXAMPLE.join("\n");
      expect(text).toContain("name:");
      expect(text).toContain("description:");
    });

    it("includes type field with all types", () => {
      const text = MEMORY_FRONTMATTER_EXAMPLE.join("\n");
      expect(text).toContain("type:");
      expect(text).toContain("user");
      expect(text).toContain("feedback");
      expect(text).toContain("project");
      expect(text).toContain("reference");
    });
  });

  describe("buildExtractAutoOnlyPrompt", () => {
    it("includes extraction subagent role", () => {
      const prompt = buildExtractAutoOnlyPrompt(20, "");
      expect(prompt).toContain("memory extraction subagent");
    });

    it("references message count", () => {
      const prompt = buildExtractAutoOnlyPrompt(42, "");
      expect(prompt).toContain("~42");
    });

    it("includes existing memories manifest when provided", () => {
      const prompt = buildExtractAutoOnlyPrompt(10, "role.md: user role");
      expect(prompt).toContain("role.md");
      expect(prompt).toContain("Existing memory files");
    });

    it("includes type taxonomy (individual mode)", () => {
      const prompt = buildExtractAutoOnlyPrompt(10, "");
      expect(prompt).toContain("<name>user</name>");
      expect(prompt).not.toContain("<scope>");
    });

    it("includes how-to-save with MEMORY.md step when not skipping index", () => {
      const prompt = buildExtractAutoOnlyPrompt(10, "", false);
      expect(prompt).toContain("Step 2");
      expect(prompt).toContain("MEMORY.md");
    });

    it("skips MEMORY.md step when skipIndex is true", () => {
      const prompt = buildExtractAutoOnlyPrompt(10, "", true);
      expect(prompt).not.toContain("Step 2");
    });
  });

  describe("buildConsolidationPrompt", () => {
    it("includes four phases", () => {
      const prompt = buildConsolidationPrompt("/mem", "/transcripts", "");
      expect(prompt).toContain("Phase 1");
      expect(prompt).toContain("Phase 2");
      expect(prompt).toContain("Phase 3");
      expect(prompt).toContain("Phase 4");
    });

    it("includes memory root path", () => {
      const prompt = buildConsolidationPrompt("/custom/mem", "/transcripts", "");
      expect(prompt).toContain("/custom/mem");
    });

    it("includes transcript directory", () => {
      const prompt = buildConsolidationPrompt("/mem", "/custom/transcripts", "");
      expect(prompt).toContain("/custom/transcripts");
    });

    it("includes extra context when provided", () => {
      const prompt = buildConsolidationPrompt("/mem", "/transcripts", "Custom extra context");
      expect(prompt).toContain("Custom extra context");
      expect(prompt).toContain("Additional context");
    });

    it("omits additional context section when extra is empty", () => {
      const prompt = buildConsolidationPrompt("/mem", "/transcripts", "");
      expect(prompt).not.toContain("Additional context");
    });

    it("includes MEMORY.md indexing guidance", () => {
      const prompt = buildConsolidationPrompt("/mem", "/transcripts", "");
      expect(prompt).toContain("MEMORY.md");
      expect(prompt).toContain("Prune and index");
    });
  });

  describe("buildMemoryLines", () => {
    it("produces lines starting with display name header", () => {
      const lines = buildMemoryLines({
        displayName: "auto memory",
        memoryDir: "/home/.claude/memory",
      });
      expect(lines[0]).toBe("# auto memory");
    });

    it("includes memory directory path", () => {
      const lines = buildMemoryLines({
        displayName: "auto memory",
        memoryDir: "/custom/path",
      });
      const text = lines.join("\n");
      expect(text).toContain("/custom/path");
    });

    it("includes DIR_EXISTS_GUIDANCE", () => {
      const lines = buildMemoryLines({
        displayName: "auto memory",
        memoryDir: "/path",
      });
      const text = lines.join("\n");
      expect(text).toContain(DIR_EXISTS_GUIDANCE);
    });

    it("includes TYPES_SECTION_INDIVIDUAL content", () => {
      const lines = buildMemoryLines({
        displayName: "auto memory",
        memoryDir: "/path",
      });
      const text = lines.join("\n");
      expect(text).toContain("<name>user</name>");
    });

    it("includes WHEN_TO_ACCESS and TRUSTING_RECALL sections", () => {
      const lines = buildMemoryLines({
        displayName: "auto memory",
        memoryDir: "/path",
      });
      const text = lines.join("\n");
      expect(text).toContain("When to access memories");
      expect(text).toContain("Before recommending");
    });

    it("includes how-to-save with MEMORY.md step by default", () => {
      const lines = buildMemoryLines({
        displayName: "auto memory",
        memoryDir: "/path",
      });
      const text = lines.join("\n");
      expect(text).toContain("Step 1");
      expect(text).toContain("Step 2");
    });

    it("skips MEMORY.md step when skipIndex is true", () => {
      const lines = buildMemoryLines({
        displayName: "auto memory",
        memoryDir: "/path",
        skipIndex: true,
      });
      const text = lines.join("\n");
      expect(text).toContain("How to save memories");
      expect(text).not.toContain("Step 2");
      expect(text).not.toContain("two-step process");
    });

    it("includes extra guidelines when provided", () => {
      const lines = buildMemoryLines({
        displayName: "auto memory",
        memoryDir: "/path",
        extraGuidelines: ["Custom project guideline"],
      });
      const text = lines.join("\n");
      expect(text).toContain("Custom project guideline");
    });
  });

  describe("buildMemoryPrompt", () => {
    it("returns full prompt string with instructions", () => {
      const prompt = buildMemoryPrompt({
        displayName: "auto memory",
        memoryDir: "/path",
        entrypointContent: "",
      });
      expect(prompt).toContain("# auto memory");
      expect(prompt).toContain("MEMORY.md");
    });

    it("includes MEMORY.md content when provided", () => {
      const prompt = buildMemoryPrompt({
        displayName: "auto memory",
        memoryDir: "/path",
        entrypointContent: "- [Role](role.md) -- user role info",
      });
      expect(prompt).toContain("role.md");
    });

    it("shows empty message when MEMORY.md is empty", () => {
      const prompt = buildMemoryPrompt({
        displayName: "auto memory",
        memoryDir: "/path",
        entrypointContent: "",
      });
      expect(prompt).toContain("currently empty");
    });

    it("truncates long MEMORY.md content", () => {
      const longContent = Array.from({ length: 300 }, (_, i) => `- Line ${i}`).join("\n");
      const prompt = buildMemoryPrompt({
        displayName: "auto memory",
        memoryDir: "/path",
        entrypointContent: longContent,
      });
      expect(prompt).toContain("WARNING");
    });
  });

  describe("DIR_EXISTS_GUIDANCE", () => {
    it("tells model to write directly without mkdir", () => {
      expect(DIR_EXISTS_GUIDANCE).toContain("write to it directly");
      expect(DIR_EXISTS_GUIDANCE).toContain("do not run mkdir");
    });
  });

  describe("DIRS_EXIST_GUIDANCE", () => {
    it("tells model both directories exist", () => {
      expect(DIRS_EXIST_GUIDANCE).toContain("Both directories");
      expect(DIRS_EXIST_GUIDANCE).toContain("do not run mkdir");
    });
  });
});
