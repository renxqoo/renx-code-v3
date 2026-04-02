import { afterEach, describe, expect, it } from "vitest";

import { parseForSecurityFromAst, resetParserForTests } from "../src/index";

afterEach(() => {
  resetParserForTests();
});

describe("parseForSecurityFromAst", () => {
  it("classifies a simple command", async () => {
    const r = await parseForSecurityFromAst("echo hello");
    if (r.kind === "parse-unavailable") {
      expect.fail(r.reason);
    }
    expect(r.kind).toBe("simple");
    if (r.kind === "simple") {
      expect(r.commands.length).toBeGreaterThanOrEqual(1);
      expect(r.commands.map((c) => c.text).join(" ")).toContain("echo");
    }
  });

  it("rejects command substitution", async () => {
    const r = await parseForSecurityFromAst("echo $(whoami)");
    if (r.kind === "parse-unavailable") {
      return;
    }
    expect(r.kind).toBe("too-complex");
  });
});
