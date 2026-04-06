import { describe, expect, it } from "vitest";

import { sanitizePathKey, PathTraversalError } from "../../src/memory/team-sync-security";

describe("sanitizePathKey", () => {
  it("accepts clean relative paths", () => {
    expect(sanitizePathKey("role.md")).toBe("role.md");
    expect(sanitizePathKey("sub/role.md")).toBe("sub/role.md");
  });

  it("rejects null bytes", () => {
    expect(() => sanitizePathKey("file\0.md")).toThrow(PathTraversalError);
  });

  it("rejects URL-encoded traversal", () => {
    expect(() => sanitizePathKey("%2e%2e%2fetc%2fpasswd")).toThrow(PathTraversalError);
  });

  it("rejects backslashes", () => {
    expect(() => sanitizePathKey("path\\to\\file")).toThrow(PathTraversalError);
  });

  it("rejects absolute paths", () => {
    expect(() => sanitizePathKey("/etc/passwd")).toThrow(PathTraversalError);
  });

  it("accepts keys with hyphens and underscores", () => {
    expect(sanitizePathKey("my-feedback_v2.md")).toBe("my-feedback_v2.md");
  });
});
