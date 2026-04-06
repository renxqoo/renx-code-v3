import { describe, expect, it } from "vitest";

import {
  truncateEntrypointContent,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
  formatMemoryManifest,
  type MemoryFileHeader,
} from "../../src/memory/memdir/entrypoint";

describe("memdir entrypoint", () => {
  describe("truncateEntrypointContent", () => {
    it("returns content unchanged when within limits", () => {
      const content = "- [Role](role.md) -- user role info\n- [Prefs](prefs.md) -- preferences";
      const result = truncateEntrypointContent(content);

      expect(result.content).toBe(content);
      expect(result.wasLineTruncated).toBe(false);
      expect(result.wasByteTruncated).toBe(false);
      expect(result.lineCount).toBe(2);
    });

    it("truncates to MAX_ENTRYPOINT_LINES (200) with warning", () => {
      // Generate 250 lines
      const lines = Array.from(
        { length: 250 },
        (_, i) => `- [Entry ${i}](entry-${i}.md) -- description ${i}`,
      );
      const content = lines.join("\n");

      const result = truncateEntrypointContent(content);

      expect(result.wasLineTruncated).toBe(true);
      expect(result.lineCount).toBe(250);
      // Should contain at most 200 lines of content plus warning
      const resultLines = result.content.split("\n");
      const warningIndex = resultLines.findIndex((l) => l.includes("WARNING"));
      expect(warningIndex).toBeGreaterThan(0);
    });

    it("truncates to MAX_ENTRYPOINT_BYTES (25KB) with warning", () => {
      // Generate content that's under 200 lines but over 25KB
      const longLine = `- [Entry](entry.md) -- ${"x".repeat(500)}`;
      const lines = Array.from({ length: 60 }, () => longLine);
      const content = lines.join("\n");

      const result = truncateEntrypointContent(content);

      expect(result.wasByteTruncated).toBe(true);
      expect(result.byteCount).toBeGreaterThan(MAX_ENTRYPOINT_BYTES);
      expect(result.content).toContain("WARNING");
    });

    it("handles both line and byte truncation simultaneously", () => {
      // 200+ lines where each line is very long
      const lines = Array.from(
        { length: 250 },
        (_, i) => `- [Entry ${i}](entry-${i}.md) -- ${"y".repeat(200)}`,
      );
      const content = lines.join("\n");

      const result = truncateEntrypointContent(content);

      expect(result.wasLineTruncated).toBe(true);
      // Byte truncation may or may not trigger depending on line length
      expect(result.content).toContain("WARNING");
    });

    it("trims whitespace before processing", () => {
      const content = "  \n- [Entry](entry.md) -- desc\n  ";
      const result = truncateEntrypointContent(content);

      expect(result.content).not.toMatch(/^\s/);
      expect(result.content).not.toMatch(/\s$/);
    });
  });

  describe("formatMemoryManifest", () => {
    it("formats headers as manifest lines", () => {
      const headers: MemoryFileHeader[] = [
        {
          filename: "role.md",
          filePath: "/memory/role.md",
          mtimeMs: new Date("2026-04-05T12:00:00Z").getTime(),
          description: "User role info",
          type: "user",
        },
        {
          filename: "prefs.md",
          filePath: "/memory/prefs.md",
          mtimeMs: new Date("2026-04-04T08:00:00Z").getTime(),
          description: "User preferences",
          type: "feedback",
        },
      ];

      const manifest = formatMemoryManifest(headers);

      expect(manifest).toContain("[user] role.md");
      expect(manifest).toContain("User role info");
      expect(manifest).toContain("[feedback] prefs.md");
      expect(manifest).toContain("User preferences");
    });

    it("omits type tag when type is undefined", () => {
      const headers: MemoryFileHeader[] = [
        {
          filename: "legacy.md",
          filePath: "/memory/legacy.md",
          mtimeMs: Date.now(),
          description: "Legacy entry",
          type: undefined,
        },
      ];

      const manifest = formatMemoryManifest(headers);
      expect(manifest).not.toContain("[undefined]");
      expect(manifest).toContain("legacy.md");
      expect(manifest).toContain("Legacy entry");
    });

    it("handles empty headers array", () => {
      const manifest = formatMemoryManifest([]);
      expect(manifest).toBe("");
    });

    it("handles header without description", () => {
      const headers: MemoryFileHeader[] = [
        {
          filename: "nodesc.md",
          filePath: "/memory/nodesc.md",
          mtimeMs: Date.now(),
          description: null,
          type: "project",
        },
      ];

      const manifest = formatMemoryManifest(headers);
      expect(manifest).toContain("[project] nodesc.md");
      expect(manifest).not.toContain(": ");
    });
  });
});
