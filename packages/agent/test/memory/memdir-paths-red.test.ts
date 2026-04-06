import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isAutoMemPath,
  validateMemoryPath,
  getAutoMemPath,
  isAutoMemoryEnabled,
} from "../../src/memory/memdir/paths";

describe("memdir paths", () => {
  describe("isAutoMemPath", () => {
    it("returns true for paths within the memory directory", () => {
      const memoryDir = "/home/user/.claude/projects/my-project/memory";
      expect(
        isAutoMemPath("/home/user/.claude/projects/my-project/memory/role.md", memoryDir),
      ).toBe(true);
      expect(
        isAutoMemPath("/home/user/.claude/projects/my-project/memory/sub/note.md", memoryDir),
      ).toBe(true);
    });

    it("returns false for paths outside the memory directory", () => {
      const memoryDir = "/home/user/.claude/projects/my-project/memory";
      expect(isAutoMemPath("/home/user/.claude/projects/my-project/src/index.ts", memoryDir)).toBe(
        false,
      );
      expect(isAutoMemPath("/home/user/other/path.md", memoryDir)).toBe(false);
    });

    it("handles trailing separators correctly", () => {
      const memoryDir = "/home/user/.claude/projects/my-project/memory/";
      expect(
        isAutoMemPath("/home/user/.claude/projects/my-project/memory/role.md", memoryDir),
      ).toBe(true);
    });

    it("rejects path traversal attempts", () => {
      const memoryDir = "/home/user/.claude/projects/my-project/memory";
      expect(
        isAutoMemPath(
          "/home/user/.claude/projects/my-project/memory/../../../etc/passwd",
          memoryDir,
        ),
      ).toBe(false);
    });
  });

  describe("validateMemoryPath", () => {
    it("accepts valid absolute paths", () => {
      // Use resolve to get a platform-appropriate absolute path
      const validPath = resolve("/tmp/memory/test.md");
      expect(() => validateMemoryPath(validPath)).not.toThrow();
    });

    it("rejects relative paths", () => {
      expect(() => validateMemoryPath("relative/path.md")).toThrow();
    });

    it("rejects null bytes", () => {
      expect(() => validateMemoryPath("/valid/path\0.md")).toThrow();
    });

    it("rejects root paths", () => {
      expect(() => validateMemoryPath("/")).toThrow();
    });

    it("rejects UNC paths on Windows-like input", () => {
      expect(() => validateMemoryPath("\\\\server\\share\\file.md")).toThrow();
    });
  });

  describe("getAutoMemPath", () => {
    it("returns default path structure", () => {
      const path = getAutoMemPath({
        memoryBase: "/home/user/.claude",
        projectRoot: "/home/user/projects/my-project",
      });
      expect(path).toContain("projects");
      expect(path).toContain("memory");
    });

    it("respects override path", () => {
      const path = getAutoMemPath({
        overridePath: "/custom/memory/path",
        memoryBase: "/home/user/.claude",
        projectRoot: "/home/user/projects/my-project",
      });
      expect(path).toBe(resolve("/custom/memory/path"));
    });
  });

  describe("isAutoMemoryEnabled", () => {
    it("returns true by default", () => {
      expect(isAutoMemoryEnabled({})).toBe(true);
    });

    it("returns false when disabled by env var", () => {
      expect(isAutoMemoryEnabled({ disableEnvVar: "true" })).toBe(false);
      expect(isAutoMemoryEnabled({ disableEnvVar: "1" })).toBe(false);
    });

    it("returns false when disabled by setting", () => {
      expect(isAutoMemoryEnabled({ autoMemoryEnabled: false })).toBe(false);
    });

    it("returns false when bare mode is on", () => {
      expect(isAutoMemoryEnabled({ bareMode: true })).toBe(false);
    });
  });
});
