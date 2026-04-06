import { describe, expect, it } from "vitest";

import {
  detectSessionFileType,
  isAutoMemFile,
  memoryScopeForPath,
} from "../../src/memory/detection";

describe("memory detection", () => {
  describe("detectSessionFileType", () => {
    it("detects session memory files", () => {
      expect(detectSessionFileType("/home/.claude/session-memory/notes.md")).toBe("session_memory");
    });

    it("detects session transcript files", () => {
      expect(detectSessionFileType("/home/.claude/projects/abc-123/session.jsonl")).toBe(
        "session_transcript",
      );
    });

    it("returns null for non-session files", () => {
      expect(detectSessionFileType("/home/.claude/projects/abc-123/memory/role.md")).toBeNull();
      expect(detectSessionFileType("/home/user/src/index.ts")).toBeNull();
    });

    it("returns null for non-md session memory paths", () => {
      expect(detectSessionFileType("/home/.claude/session-memory/notes.txt")).toBeNull();
    });

    it("returns null for non-jsonl transcript paths", () => {
      expect(detectSessionFileType("/home/.claude/projects/abc-123/session.json")).toBeNull();
    });
  });

  describe("isAutoMemFile", () => {
    it("returns true for paths within auto-memory directory", () => {
      expect(
        isAutoMemFile(
          "/home/.claude/projects/abc/memory/role.md",
          "/home/.claude/projects/abc/memory",
        ),
      ).toBe(true);
    });

    it("returns false for paths outside auto-memory directory", () => {
      expect(isAutoMemFile("/home/src/index.ts", "/home/.claude/projects/abc/memory")).toBe(false);
    });

    it("returns false when memory is disabled", () => {
      expect(
        isAutoMemFile(
          "/home/.claude/projects/abc/memory/role.md",
          "/home/.claude/projects/abc/memory",
          false,
        ),
      ).toBe(false);
    });
  });

  describe("memoryScopeForPath", () => {
    it("returns personal for auto-memory paths", () => {
      expect(
        memoryScopeForPath(
          "/home/.claude/projects/abc/memory/role.md",
          "/home/.claude/projects/abc/memory",
        ),
      ).toBe("personal");
    });

    it("returns null for non-memory paths", () => {
      expect(
        memoryScopeForPath("/home/src/index.ts", "/home/.claude/projects/abc/memory"),
      ).toBeNull();
    });

    it("returns null when memory is disabled", () => {
      expect(
        memoryScopeForPath(
          "/home/.claude/projects/abc/memory/role.md",
          "/home/.claude/projects/abc/memory",
          false,
        ),
      ).toBeNull();
    });
  });
});
