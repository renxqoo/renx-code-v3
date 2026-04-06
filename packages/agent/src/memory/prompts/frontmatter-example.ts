/**
 * Memory frontmatter format example.
 *
 * 1:1 replicate of MEMORY_FRONTMATTER_EXAMPLE from claude-code-source.
 */

import { MEMORY_TYPES } from "./types-section";

export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  "```markdown",
  "---",
  "name: {{memory name}}",
  "description: {{one-line description — used to decide relevance in future conversations, so be specific}}",
  `type: {{${MEMORY_TYPES.join(", ")}}}`,
  "---",
  "",
  "{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}",
  "```",
];
