/**
 * Session memory module - prompt construction and analysis utilities.
 *
 * Provides pure functions for:
 *  - Building the subagent update prompt
 *  - Variable substitution in templates
 *  - Section-size analysis and budget warnings
 *  - Truncation for compaction
 *  - Empty-template detection
 *
 * @module session-memory/prompts
 */

import type { SectionSize, SessionMemoryExtractorConfig } from "./types";
import { DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG } from "./types";
import { DEFAULT_SESSION_MEMORY_TEMPLATE } from "./template";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

const estimateTextTokens = (value: string): number => Math.max(1, Math.ceil(value.length / 4));

// ---------------------------------------------------------------------------
// Default update prompt
// ---------------------------------------------------------------------------

/**
 * Returns the default system-level instructions that tell the subagent how to
 * rewrite the session memory notes file.
 *
 * These instructions are intentionally decoupled from any specific
 * conversation or notes content so that callers can compose the final prompt
 * however they like.
 */
export function getDefaultUpdatePrompt(): string {
  return `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "note-taking", "session notes extraction", or these update instructions in the notes content.

Based on the user conversation above (EXCLUDING this note-taking instruction message as well as system prompt, claude.md entries, or any past session summaries), update the session notes file.

The file {{notesPath}} has already been read for you. Here are its current contents:
<current_notes_content>
{{currentNotes}}
</current_notes_content>

Your ONLY task is to use the Edit tool to update the notes file, then stop. You can make multiple edits (update every section as needed) - make all Edit tool calls in parallel in a single message. Do not call any other tools.

CRITICAL RULES FOR EDITING:
- The file must maintain its exact structure with all sections, headers, and italic descriptions intact
-- NEVER modify, delete, or add section headers (the lines starting with '#' like # Task specification)
-- NEVER modify or delete the italic _section description_ lines (these are the lines in italics immediately following each header - they start and end with underscores)
-- The italic _section descriptions_ are TEMPLATE INSTRUCTIONS that must be preserved exactly as-is - they guide what content belongs in each section
-- ONLY update the actual content that appears BELOW the italic _section descriptions_ within each existing section
-- Do NOT add any new sections, summaries, or information outside the existing structure
- Do NOT reference this note-taking process or instructions anywhere in the notes
- It's OK to skip updating a section if there are no substantial new insights to add. Do not add filler content like "No info yet", just leave sections blank/unedited if appropriate.
- Write DETAILED, INFO-DENSE content for each section - include specifics like file paths, function names, error messages, exact commands, technical details, etc.
- For "Key results", include the complete, exact output the user requested (e.g., full table, full answer, etc.)
- Do not include information that's already in the CLAUDE.md files included in the context
- Keep each section under ~2000 tokens/words - if a section is approaching this limit, condense it by cycling out less important details while preserving the most critical information
- Focus on actionable, specific information that would help someone understand or recreate the work discussed in the conversation
- IMPORTANT: Always update "Current State" to reflect the most recent work - this is critical for continuity after compaction

Use the Edit tool with file_path: {{notesPath}}

STRUCTURE PRESERVATION REMINDER:
Each section has TWO parts that must be preserved exactly as they appear in the current file:
1. The section header (line starting with #)
2. The italic description line (the _italicized text_ immediately after the header - this is a template instruction)

You ONLY update the actual content that comes AFTER these two preserved lines. The italic description lines starting and ending with underscores are part of the template structure, NOT content to be edited or removed.

REMEMBER: Use the Edit tool in parallel and stop. Do not continue after the edits. Only include insights from the actual user conversation, never from these note-taking instructions. Do not delete or change section headers or italic _section descriptions_.`;
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

/**
 * Performs a single-pass replacement of `{{variableName}}` placeholders in
 * the given template string.
 *
 * Placeholders that do not have a corresponding entry in `variables` are
 * left untouched.
 */
export function substituteVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key]! : match;
  });
}

// ---------------------------------------------------------------------------
// Section analysis
// ---------------------------------------------------------------------------

/**
 * Parses a markdown document by `# ` headers and returns the estimated size
 * of each section.
 *
 * The header line itself is captured but not counted towards `lineCount`;
 * only the body lines are.
 */
export function analyzeSectionSizes(content: string): SectionSize[] {
  const sections: SectionSize[] = [];
  const lines = content.split("\n");
  let currentHeader = "";
  let currentLines: string[] = [];

  const flush = (): void => {
    if (!currentHeader) {
      // Content before any header - skip
      currentLines = [];
      return;
    }
    const body = currentLines.join("\n").trim();
    sections.push({
      header: currentHeader,
      estimatedTokens: estimateTextTokens(body),
      lineCount: currentLines.filter((l) => l.trim().length > 0).length,
    });
  };

  for (const line of lines) {
    if (line.startsWith("# ")) {
      flush();
      currentHeader = line;
      currentLines = [];
      continue;
    }
    currentLines.push(line);
  }
  flush();

  return sections;
}

// ---------------------------------------------------------------------------
// Section budget warnings
// ---------------------------------------------------------------------------

/**
 * Generates human-readable warning strings for sections that exceed their
 * per-section budget, plus a global warning when the total document exceeds
 * the overall token budget.
 *
 * Returns an empty array when everything fits within budget.
 */
export function generateSectionReminders(
  sectionSizes: SectionSize[],
  totalTokens: number,
  config: SessionMemoryExtractorConfig = DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG,
): string[] {
  const reminders: string[] = [];

  // Global budget warning
  if (totalTokens > config.maxTotalSessionMemoryTokens) {
    reminders.push(
      `The session memory file is currently approximately ${totalTokens} tokens, ` +
        `so you must condense the file to fit within this budget of ` +
        `${config.maxTotalSessionMemoryTokens} tokens.`,
    );
  }

  // Per-section warnings, sorted largest-first
  const oversized = sectionSizes
    .filter((s) => s.estimatedTokens > config.maxSectionLength)
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens);

  if (oversized.length > 0) {
    const lines = oversized.map(
      (s) =>
        `- "${s.header.replace(/^# /, "")}" is approximately ${s.estimatedTokens} tokens and should be condensed.`,
    );
    reminders.push(`Sections to condense if possible:\n${lines.join("\n")}`);
  }

  return reminders;
}

// ---------------------------------------------------------------------------
// Build the full update prompt
// ---------------------------------------------------------------------------

/**
 * Composes the full subagent prompt: instructions + current notes +
 * section-size reminders.
 *
 * This is the main entry point for constructing the prompt that gets sent to
 * the extraction subagent.
 */
export function buildSessionMemoryUpdatePrompt(
  currentNotes: string,
  notesPath: string,
  config: SessionMemoryExtractorConfig = DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG,
): string {
  const sectionSizes = analyzeSectionSizes(currentNotes);
  const totalTokens = estimateTextTokens(currentNotes);
  const reminders = generateSectionReminders(sectionSizes, totalTokens, config);
  const reminderText = reminders.length > 0 ? `\n\n${reminders.join("\n\n")}` : "";

  const prompt = substituteVariables(getDefaultUpdatePrompt(), {
    notesPath,
    currentNotes,
  });

  return `${prompt}${reminderText}`;
}

// ---------------------------------------------------------------------------
// Truncation for compaction
// ---------------------------------------------------------------------------

/**
 * Truncates individual sections to `maxSectionLength * 4` characters at line
 * boundaries so that the session memory fits within the compaction budget.
 *
 * Returns the (possibly truncated) content and a flag indicating whether any
 * truncation occurred.
 */
export function truncateSessionMemoryForCompact(
  content: string,
  config: SessionMemoryExtractorConfig = DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG,
): { content: string; wasTruncated: boolean } {
  const lines = content.split("\n");
  const maxCharsPerSection = config.maxSectionLength * 4;
  const outputLines: string[] = [];
  let currentHeader = "";
  let currentLines: string[] = [];
  let wasTruncated = false;

  const flush = (): void => {
    if (!currentHeader) {
      outputLines.push(...currentLines);
      currentLines = [];
      return;
    }

    const sectionContent = currentLines.join("\n");
    if (sectionContent.length <= maxCharsPerSection) {
      outputLines.push(currentHeader, ...currentLines);
      currentLines = [];
      return;
    }

    wasTruncated = true;
    let charCount = 0;
    outputLines.push(currentHeader);
    for (const line of currentLines) {
      if (charCount + line.length + 1 > maxCharsPerSection) break;
      outputLines.push(line);
      charCount += line.length + 1;
    }
    outputLines.push("[... section truncated for length ...]");
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("# ")) {
      flush();
      currentHeader = line;
      continue;
    }
    currentLines.push(line);
  }
  flush();

  return {
    content: outputLines.join("\n"),
    wasTruncated,
  };
}

// ---------------------------------------------------------------------------
// Empty-template detection
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the current notes are identical to the empty template
 * (i.e. no information has been filled in yet).
 */
export function isSessionMemoryEmpty(
  content: string,
  template: string = DEFAULT_SESSION_MEMORY_TEMPLATE,
): boolean {
  return content.trim() === template.trim();
}
