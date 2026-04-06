import type { MemoryTaxonomyType } from "./types";

export const MEMORY_TAXONOMY_TYPES = [
  "user",
  "feedback",
  "project",
  "reference",
] as const satisfies readonly MemoryTaxonomyType[];

const TYPES_SECTION = [
  "## Types of memory",
  "",
  "- `user`: stable information about the user's role, preferences, responsibilities, or knowledge.",
  "- `feedback`: guidance about how the agent should work, including corrections and validated approaches.",
  "- `project`: non-derivable project facts, decisions, timelines, incidents, and coordination context.",
  "- `reference`: pointers to external systems, dashboards, tickets, or docs.",
];

const WHAT_NOT_TO_SAVE = [
  "## What NOT to save in memory",
  "",
  "- Code structure, file paths, architecture, and conventions that can be re-derived from the repo.",
  "- Git history, recent diffs, or activity logs.",
  "- Ephemeral task state that belongs in working/session memory instead of durable semantic memory.",
];

const WHEN_TO_ACCESS = [
  "## When to access memories",
  "",
  "- Recall memory when the user references prior work or asks to remember/check memory.",
  "- If the caller explicitly says to ignore memory, behave as if semantic memory were empty.",
];

const TRUST_MEMORY = [
  "## Before recommending from memory",
  "",
  "- Treat memory as a historical claim, not guaranteed current truth.",
  "- Verify named files, functions, flags, or dashboards against current state before relying on them.",
];

export const parseMemoryTaxonomyType = (value: unknown): MemoryTaxonomyType | undefined => {
  if (typeof value !== "string") return undefined;
  return MEMORY_TAXONOMY_TYPES.find((type) => type === value);
};

export const buildMemoryTaxonomyPrompt = (input?: { mode?: "combined" | "individual" }): string => {
  const modeLine =
    input?.mode === "combined"
      ? "This memory system may combine private and shared scopes."
      : "This memory system uses a single scope unless the SDK config adds more.";
  return [
    modeLine,
    "",
    ...TYPES_SECTION,
    "",
    ...WHAT_NOT_TO_SAVE,
    "",
    ...WHEN_TO_ACCESS,
    "",
    ...TRUST_MEMORY,
  ].join("\n");
};
