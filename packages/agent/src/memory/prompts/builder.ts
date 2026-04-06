/**
 * Memory prompt builders.
 *
 * 1:1 replicate of claude-code-source/src/memdir/memdir.ts prompt building
 * logic (buildMemoryLines, buildMemoryPrompt).
 *
 * Adapted for renx-code-v3: removed Bun/feature-flag dependencies,
 * uses injected parameters instead of global state.
 */

import {
  truncateEntrypointContent,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from "../memdir/entrypoint";
import { TYPES_SECTION_INDIVIDUAL } from "./types-section";
import { WHAT_NOT_TO_SAVE_SECTION } from "./what-not-to-save";
import { WHEN_TO_ACCESS_SECTION } from "./when-to-access";
import { TRUSTING_RECALL_SECTION } from "./trusting-recall";
import { MEMORY_FRONTMATTER_EXAMPLE } from "./frontmatter-example";

export const DIR_EXISTS_GUIDANCE =
  "This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).";
export const DIRS_EXIST_GUIDANCE =
  "Both directories already exist — write to them directly with the Write tool (do not run mkdir or check for their existence).";

/**
 * Build the typed-memory behavioral instructions (without MEMORY.md content).
 *
 * 1:1 replicate of buildMemoryLines from claude-code-source/memdir.ts.
 */
export function buildMemoryLines(input: {
  displayName: string;
  memoryDir: string;
  extraGuidelines?: string[];
  skipIndex?: boolean;
  /** Whether to include the "Searching past context" section. Default: false. */
  enableSearchPastContext?: boolean;
}): string[] {
  const {
    displayName,
    memoryDir,
    extraGuidelines,
    skipIndex = false,
    enableSearchPastContext = false,
  } = input;

  const howToSave = skipIndex
    ? [
        "## How to save memories",
        "",
        "Write each memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
        "",
        ...MEMORY_FRONTMATTER_EXAMPLE,
        "",
        "- Keep the name, description, and type fields in memory files up-to-date with the content",
        "- Organize memory semantically by topic, not chronologically",
        "- Update or remove memories that turn out to be wrong or outdated",
        "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
      ]
    : [
        "## How to save memories",
        "",
        "Saving a memory is a two-step process:",
        "",
        "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
        "",
        ...MEMORY_FRONTMATTER_EXAMPLE,
        "",
        `**Step 2** — add a pointer to that file in \`${ENTRYPOINT_NAME}\`. \`${ENTRYPOINT_NAME}\` is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${ENTRYPOINT_NAME}\`.`,
        "",
        `- \`${ENTRYPOINT_NAME}\` is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
        "- Keep the name, description, and type fields in memory files up-to-date with the content",
        "- Organize memory semantically by topic, not chronologically",
        "- Update or remove memories that turn out to be wrong or outdated",
        "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
      ];

  const lines: string[] = [
    `# ${displayName}`,
    "",
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    "",
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    "",
    ...howToSave,
    "",
    ...WHEN_TO_ACCESS_SECTION,
    "",
    ...TRUSTING_RECALL_SECTION,
    "",
    "## Memory and other forms of persistence",
    "Memory is one of several persistence mechanisms available to you as you assist the user in a given conversation. The distinction is often that memory can be recalled in future conversations and should not be used for persisting information that is only useful within the scope of the current conversation.",
    "- When to use or update a plan instead of memory: If you are about to start a non-trivial implementation task and would like to reach alignment with the user on your approach you should use a Plan rather than saving this information to memory. Similarly, if you already have a plan within the conversation and you have changed your approach persist that change by updating the plan rather than saving a memory.",
    "- When to use or update tasks instead of memory: When you need to break your work in current conversation into discrete steps or keep track of your progress use tasks instead of saving to memory. Tasks are great for persisting information about the work that needs to be done in the current conversation, but memory should be reserved for information that will be useful in future conversations.",
    "",
    ...(extraGuidelines ?? []),
    "",
  ];

  // Append searching-past-context section if enabled
  if (enableSearchPastContext) {
    lines.push(...buildSearchingPastContextSection(memoryDir));
  }

  return lines;
}

/**
 * Build the full memory prompt with MEMORY.md content included.
 *
 * 1:1 replicate of buildMemoryPrompt from claude-code-source/memdir.ts.
 * Accepts entrypointContent as parameter instead of reading from filesystem.
 */
export function buildMemoryPrompt(input: {
  displayName: string;
  memoryDir: string;
  entrypointContent: string;
  extraGuidelines?: string[];
  skipIndex?: boolean;
}): string {
  const { displayName, memoryDir, entrypointContent, extraGuidelines, skipIndex = false } = input;

  const lines = buildMemoryLines({
    displayName,
    memoryDir,
    ...(extraGuidelines ? { extraGuidelines } : {}),
    skipIndex,
  });

  if (entrypointContent.trim()) {
    const t = truncateEntrypointContent(entrypointContent);
    lines.push(`## ${ENTRYPOINT_NAME}`, "", t.content);
  } else {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      "",
      `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
    );
  }

  return lines.join("\n");
}

/**
 * Build the "Searching past context" section that guides the model on
 * how to search memory files and session transcripts.
 *
 * 1:1 replicate of buildSearchingPastContextSection from claude-code-source.
 */
export function buildSearchingPastContextSection(autoMemDir: string): string[] {
  return [
    "## Searching past context",
    "",
    "When looking for past context:",
    "1. Search topic files in your memory directory:",
    "```",
    `Grep with pattern="<search term>" path="${autoMemDir}" glob="*.md"`,
    "```",
    "2. Session transcript logs (last resort — large files, slow):",
    "```",
    `Grep with pattern="<search term>" path="<project-dir>/" glob="*.jsonl"`,
    "```",
    "Use narrow search terms (error messages, file paths, function names) rather than broad keywords.",
    "",
  ];
}

/**
 * Build the assistant daily-log prompt for KAIROS mode.
 *
 * In KAIROS/assistant mode, the agent writes memories append-only to
 * date-named log files rather than maintaining MEMORY.md as a live index.
 * A separate nightly /dream skill distills logs into topic files + MEMORY.md.
 *
 * 1:1 replicate of buildAssistantDailyLogPrompt from claude-code-source.
 */
export function buildAssistantDailyLogPrompt(input: {
  memoryDir: string;
  skipIndex?: boolean;
  enableSearchPastContext?: boolean;
}): string {
  const { memoryDir, skipIndex = false, enableSearchPastContext = false } = input;
  const logPathPattern = `${memoryDir}/logs/YYYY/MM/YYYY-MM-DD.md`;

  const lines: string[] = [
    "# auto memory",
    "",
    `You have a persistent, file-based memory system found at: \`${memoryDir}\``,
    "",
    "This session is long-lived. As you work, record anything worth remembering by **appending** to today's daily log file:",
    "",
    `\`${logPathPattern}\``,
    "",
    "Substitute today's date (from `currentDate` in your context) for `YYYY-MM-DD`. When the date rolls over mid-session, start appending to the new day's file.",
    "",
    "Write each entry as a short timestamped bullet. Create the file (and parent directories) on first write if it does not exist. Do not rewrite or reorganize the log — it is append-only. A separate nightly process distills these logs into `MEMORY.md` and topic files.",
    "",
    "## What to log",
    '- User corrections and preferences ("use bun, not npm"; "stop summarizing diffs")',
    "- Facts about the user, their role, or their goals",
    "- Project context that is not derivable from the code (deadlines, incidents, decisions and their rationale)",
    "- Pointers to external systems (dashboards, Linear projects, Slack channels)",
    "- Anything the user explicitly asks you to remember",
    "",
    ...WHAT_NOT_TO_SAVE_SECTION,
    "",
  ];

  if (!skipIndex) {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      `\`${ENTRYPOINT_NAME}\` is the distilled index (maintained nightly from your logs) and is loaded into your context automatically. Read it for orientation, but do not edit it directly — record new information in today's log instead.`,
      "",
    );
  }

  if (enableSearchPastContext) {
    lines.push(...buildSearchingPastContextSection(memoryDir));
  }

  return lines.join("\n");
}
