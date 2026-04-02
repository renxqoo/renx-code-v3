import type { BashSecurityVerdict } from "../security";

export type EnterpriseValidationContext = {
  originalCommand: string;
  baseCommand: string;
  unquotedContent: string;
  fullyUnquotedContent: string;
  fullyUnquotedPreStrip: string;
  unquotedKeepQuoteChars: string;
  /** Recursive check on stripped remainder (safe heredoc). */
  checkRemainder: (cmd: string) => BashSecurityVerdict;
  /** When set, skips some regex-only checks that tree-sitter disproves. */
  treeSitter: { hasActualOperatorNodes: boolean } | null;
};

export type QuoteExtraction = {
  withDoubleQuotes: string;
  fullyUnquoted: string;
  unquotedKeepQuoteChars: string;
};

export function extractQuotedContent(command: string, isJq = false): QuoteExtraction {
  let withDoubleQuotes = "";
  let fullyUnquoted = "";
  let unquotedKeepQuoteChars = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;

    if (escaped) {
      escaped = false;
      if (!inSingleQuote) withDoubleQuotes += char;
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char;
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char;
      continue;
    }

    if (char === "\\" && !inSingleQuote) {
      escaped = true;
      if (!inSingleQuote) withDoubleQuotes += char;
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char;
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      unquotedKeepQuoteChars += char;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      unquotedKeepQuoteChars += char;
      if (!isJq) continue;
    }

    if (!inSingleQuote) withDoubleQuotes += char;
    if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char;
    if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char;
  }

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars };
}

export function stripSafeRedirections(content: string): string {
  return content
    .replace(/\s+2\s*>&\s*1(?=\s|$)/g, "")
    .replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, "")
    .replace(/\s*<\s*\/dev\/null(?=\s|$)/g, "");
}

export function hasUnescapedChar(content: string, char: string): boolean {
  if (char.length !== 1) {
    throw new Error("hasUnescapedChar only works with single characters");
  }
  let i = 0;
  while (i < content.length) {
    if (content[i] === "\\" && i + 1 < content.length) {
      i += 2;
      continue;
    }
    if (content[i] === char) {
      return true;
    }
    i++;
  }
  return false;
}

/** First command word after assignments / zsh premodifiers (lowercase, for jq obfuscation checks). */
export function resolveBaseCommandWord(command: string): string {
  const ZSH_PRECOMMAND_MODIFIERS = new Set(["command", "builtin", "noglob", "nocorrect"]);
  const trimmed = command.trim();
  const tokens = trimmed.split(/\s+/);
  for (const token of tokens) {
    if (/^[A-Za-z_]\w*=/.test(token)) continue;
    if (ZSH_PRECOMMAND_MODIFIERS.has(token)) continue;
    return token.replace(/^\\+/, "").toLowerCase();
  }
  return "";
}
