import { describe, expect, it } from "vitest";

import {
  FRONTMATTER_REGEX,
  parseFrontmatter,
  quoteProblematicValues,
} from "../../src/memory/memdir/frontmatter";

describe("memdir frontmatter parser", () => {
  it("parses valid YAML frontmatter with name, description, and type", () => {
    const input = `---
name: user_role
description: User is a senior backend engineer
type: user
---
User prefers functional programming patterns.
Has 10 years of Go experience.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter.name).toBe("user_role");
    expect(result.frontmatter.description).toBe("User is a senior backend engineer");
    expect(result.frontmatter.type).toBe("user");
    expect(result.content).toBe(
      "User prefers functional programming patterns.\nHas 10 years of Go experience.",
    );
  });

  it("returns empty frontmatter for files without frontmatter", () => {
    const input = "Just some regular markdown content\nwithout any frontmatter.";
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({});
    expect(result.content).toBe(input);
  });

  it("handles frontmatter with tags array", () => {
    const input = `---
name: test_feedback
description: A feedback entry
type: feedback
tags:
  - testing
  - memory
---
Content here.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter.name).toBe("test_feedback");
    expect(result.frontmatter.tags).toEqual(["testing", "memory"]);
  });

  it("handles malformed frontmatter gracefully", () => {
    const input = `---
name: broken
description: [unclosed bracket
type: user
---
Content.`;

    const result = parseFrontmatter(input);
    // Should still return something, even if partial
    expect(result).toBeDefined();
    expect(result.content).toContain("Content.");
  });

  it("strips content correctly when frontmatter is present", () => {
    const input = `---
name: test
---
Body content here.`;

    const result = parseFrontmatter(input);
    expect(result.content).toBe("Body content here.");
    expect(result.frontmatter.name).toBe("test");
  });

  it("handles empty frontmatter block", () => {
    const input = `---
---
Body after empty frontmatter.`;

    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({});
    expect(result.content).toBe("Body after empty frontmatter.");
  });

  it("FRONTMATTER_REGEX matches standard frontmatter", () => {
    const match = "---\nname: test\n---\n".match(FRONTMATTER_REGEX);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("name: test\n");
  });

  it("FRONTMATTER_REGEX returns null for non-frontmatter content", () => {
    const match = "no frontmatter here".match(FRONTMATTER_REGEX);
    expect(match).toBeNull();
  });
});

describe("quoteProblematicValues", () => {
  it("quotes values containing YAML special characters", () => {
    const input = "paths: **/*.{ts,tsx}";
    const result = quoteProblematicValues(input);
    expect(result).toBe('paths: "**/*.{ts,tsx}"');
  });

  it("does not double-quote already quoted values", () => {
    const input = 'paths: "**/*.ts"';
    const result = quoteProblematicValues(input);
    expect(result).toBe('paths: "**/*.ts"');
  });

  it("leaves plain values unquoted", () => {
    const input = "name: simple_name";
    const result = quoteProblematicValues(input);
    expect(result).toBe("name: simple_name");
  });

  it("handles colon-space in values", () => {
    const input = "description: this has: a colon space";
    const result = quoteProblematicValues(input);
    expect(result).toContain('"');
  });
});
