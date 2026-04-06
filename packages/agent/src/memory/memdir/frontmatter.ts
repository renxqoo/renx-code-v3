/**
 * Memory file frontmatter parser.
 *
 * 1:1 replicate of claude-code-source/src/utils/frontmatterParser.ts,
 * specialized for memory files (name, description, type, tags).
 *
 * Parses YAML frontmatter between `---` delimiters in markdown files.
 * Falls back to `quoteProblematicValues()` on first parse failure,
 * matching the original two-pass strategy.
 */

// Characters that require quoting in YAML values (when unquoted)
const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /;

/**
 * Pre-processes frontmatter text to quote values that contain special YAML characters.
 * This allows glob patterns with special YAML chars to be parsed correctly.
 */
export function quoteProblematicValues(frontmatterText: string): string {
  const lines = frontmatterText.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const match = line.match(/^([a-zA-Z_-]+):\s+(.+)$/);
    if (match) {
      const [, key, value] = match;
      if (!key || !value) {
        result.push(line);
        continue;
      }

      // Skip if already quoted
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        result.push(line);
        continue;
      }

      // Quote if contains special YAML characters
      if (YAML_SPECIAL_CHARS.test(value)) {
        const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        result.push(`${key}: "${escaped}"`);
        continue;
      }
    }

    result.push(line);
  }

  return result.join("\n");
}

export const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/;

export type MemoryFrontmatter = {
  name?: string;
  description?: string;
  type?: string;
  tags?: string[];
  [key: string]: unknown;
};

export type ParsedMemoryFile = {
  frontmatter: MemoryFrontmatter;
  content: string;
};

/**
 * Parse scalar YAML value.
 * Handles: booleans, null, quoted strings, arrays, and plain strings.
 */
const parseScalar = (value: string): unknown => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry: string) => entry.trim())
      .filter((entry: string) => entry.length > 0)
      .map((entry: string) => String(parseScalar(entry)));
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

/**
 * Parses markdown content to extract frontmatter and body content.
 *
 * Two-pass strategy matching claude-code-source:
 * 1. Try parsing raw frontmatter
 * 2. On failure, retry with `quoteProblematicValues()` applied
 */
export function parseFrontmatter(markdown: string, _sourcePath?: string): ParsedMemoryFile {
  const match = markdown.match(FRONTMATTER_REGEX);

  if (!match) {
    return { frontmatter: {}, content: markdown };
  }

  const frontmatterText = match[1] || "";
  const content = markdown.slice(match[0].length);

  let frontmatter: MemoryFrontmatter = {};

  try {
    frontmatter = parseYamlSimple(frontmatterText);
  } catch {
    // Retry with quoted values
    try {
      const quotedText = quoteProblematicValues(frontmatterText);
      frontmatter = parseYamlSimple(quotedText);
    } catch {
      // Both passes failed — return empty frontmatter
    }
  }

  return { frontmatter, content };
}

/**
 * Simple YAML parser for memory frontmatter.
 * Handles: key-value pairs, arrays (dash-prefixed lists), and nested values.
 * Does not depend on any external YAML library.
 */
function parseYamlSimple(text: string): MemoryFrontmatter {
  const data: MemoryFrontmatter = {};
  let currentKey: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;

    // Array item: "- value"
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentKey) {
      const nextValue = String(parseScalar(listMatch[1] ?? ""));
      const existing = data[currentKey];
      if (Array.isArray(existing)) {
        existing.push(nextValue);
      } else if (existing === "" || existing === undefined) {
        (data as Record<string, unknown>)[currentKey] = [nextValue];
      } else {
        (data as Record<string, unknown>)[currentKey] = [String(existing), nextValue];
      }
      continue;
    }

    // Key-value pair: "key: value"
    const keyMatch = line.match(/^([a-zA-Z_-][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1]!;
      const rawValue = keyMatch[2] ?? "";
      (data as Record<string, unknown>)[currentKey] = parseScalar(rawValue);
      continue;
    }
  }

  return data;
}
