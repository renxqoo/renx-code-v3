import { expansionDangerPatterns } from "../danger-patterns";
import type { EnterpriseValidationContext } from "./context";
import { hasUnescapedChar } from "./context";
import { isSafeHeredoc } from "./safe-heredoc";
import { hasMalformedTokens, tryParseShellCommand } from "./shell-quote-helpers";

export type EnterpriseValidatorResult =
  | null
  | { kind: "block"; code: string; message: string }
  | { kind: "allow_early" };

const ZSH_DANGEROUS_COMMANDS = new Set([
  "zmodload",
  "emulate",
  "sysopen",
  "sysread",
  "syswrite",
  "sysseek",
  "zpty",
  "ztcp",
  "zsocket",
  "mapfile",
  "zf_rm",
  "zf_mv",
  "zf_ln",
  "zf_chmod",
  "zf_chown",
  "zf_mkdir",
  "zf_rmdir",
  "zf_chgrp",
]);

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

const UNICODE_WS_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;

const SHELL_OPERATORS = new Set([";", "|", "&", "<", ">"]);

export function checkControlCharacters(command: string): EnterpriseValidatorResult {
  if (CONTROL_CHAR_RE.test(command)) {
    return {
      kind: "block",
      code: "CONTROL_CHARACTERS",
      message:
        "Command contains non-printable control characters that could be used to bypass security checks",
    };
  }
  return null;
}

export function validateIncompleteCommands(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  const trimmed = ctx.originalCommand.trim();
  if (/^\s*\t/.test(ctx.originalCommand)) {
    return {
      kind: "block",
      code: "INCOMPLETE_FRAGMENT_TAB",
      message: "Command appears to be an incomplete fragment (starts with tab)",
    };
  }
  if (trimmed.startsWith("-")) {
    return {
      kind: "block",
      code: "INCOMPLETE_FRAGMENT_FLAGS",
      message: "Command appears to be an incomplete fragment (starts with flags)",
    };
  }
  if (/^\s*(&&|\|\||;|>>?|<)/.test(ctx.originalCommand)) {
    return {
      kind: "block",
      code: "INCOMPLETE_FRAGMENT_OPERATOR",
      message: "Command appears to be a continuation line (starts with operator)",
    };
  }
  return null;
}

export function validateSafeCommandSubstitution(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  if (!/\$\([^)]*<</.test(ctx.originalCommand)) {
    return null;
  }
  if (isSafeHeredoc(ctx.originalCommand, ctx.checkRemainder)) {
    return { kind: "allow_early" };
  }
  return null;
}

export function validateGitCommit(ctx: EnterpriseValidationContext): EnterpriseValidatorResult {
  const { originalCommand, baseCommand } = ctx;
  if (baseCommand !== "git" || !/^git\s+commit\s+/.test(originalCommand)) {
    return null;
  }
  if (originalCommand.includes("\\")) {
    return null;
  }
  const messageMatch = originalCommand.match(
    /^git[ \t]+commit[ \t]+[^;&|`$<>()\n\r]*?-m[ \t]+(["'])([\s\S]*?)\1(.*)$/,
  );
  if (messageMatch) {
    const [, quote, messageContent, remainder] = messageMatch;
    if (quote === '"' && messageContent && /\$\(|`|\$\{/.test(messageContent)) {
      return {
        kind: "block",
        code: "GIT_COMMIT_SUBSTITUTION",
        message: "Git commit message contains command substitution patterns",
      };
    }
    if (remainder && /[;|&()`]|\$\(|\$\{/.test(remainder)) {
      return null;
    }
    if (remainder) {
      let unquoted = "";
      let inSQ = false;
      let inDQ = false;
      for (let i = 0; i < remainder.length; i++) {
        const c = remainder[i]!;
        if (c === "'" && !inDQ) {
          inSQ = !inSQ;
          continue;
        }
        if (c === '"' && !inSQ) {
          inDQ = !inDQ;
          continue;
        }
        if (!inSQ && !inDQ) unquoted += c;
      }
      if (/[<>]/.test(unquoted)) {
        return null;
      }
    }
    if (messageContent && messageContent.startsWith("-")) {
      return {
        kind: "block",
        code: "GIT_COMMIT_OBFUSCATED",
        message: "Command contains quoted characters in flag names",
      };
    }
    return { kind: "allow_early" };
  }
  return null;
}

export function validateJqCommand(ctx: EnterpriseValidationContext): EnterpriseValidatorResult {
  if (ctx.baseCommand !== "jq") {
    return null;
  }
  if (/\bsystem\s*\(/.test(ctx.originalCommand)) {
    return {
      kind: "block",
      code: "JQ_SYSTEM",
      message: "jq command contains system() function which executes arbitrary commands",
    };
  }
  const afterJq = ctx.originalCommand.substring(3).trim();
  if (/(?:^|\s)(?:-f\b|--from-file|--rawfile|--slurpfile|-L\b|--library-path)/.test(afterJq)) {
    return {
      kind: "block",
      code: "JQ_FILE_FLAGS",
      message:
        "jq command contains dangerous flags that could execute code or read arbitrary files",
    };
  }
  return null;
}

export function validateShellMetacharacters(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  const { unquotedContent } = ctx;
  const message = "Command contains shell metacharacters (;, |, or &) in arguments";
  if (/(?:^|\s)["'][^"']*[;&][^"']*["'](?:\s|$)/.test(unquotedContent)) {
    return { kind: "block", code: "SHELL_METACHARACTERS", message };
  }
  const globPatterns = [
    /-name\s+["'][^"']*[;|&][^"']*["']/,
    /-path\s+["'][^"']*[;|&][^"']*["']/,
    /-iname\s+["'][^"']*[;|&][^"']*["']/,
  ];
  if (globPatterns.some((p) => p.test(unquotedContent))) {
    return { kind: "block", code: "SHELL_METACHARACTERS", message };
  }
  if (/-regex\s+["'][^"']*[;&][^"']*["']/.test(unquotedContent)) {
    return { kind: "block", code: "SHELL_METACHARACTERS", message };
  }
  return null;
}

export function validateDangerousVariables(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  const { fullyUnquotedContent } = ctx;
  if (
    /[<>|]\s*\$[A-Za-z_]/.test(fullyUnquotedContent) ||
    /\$[A-Za-z_][A-Za-z0-9_]*\s*[|<>]/.test(fullyUnquotedContent)
  ) {
    return {
      kind: "block",
      code: "DANGEROUS_VARIABLES",
      message: "Command contains variables in dangerous contexts (redirections or pipes)",
    };
  }
  return null;
}

export function validateDangerousPatterns(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  const { unquotedContent } = ctx;
  if (hasUnescapedChar(unquotedContent, "`")) {
    return {
      kind: "block",
      code: "BACKTICK_SUBSTITUTION",
      message: "Command contains backticks (`) for command substitution",
    };
  }
  for (const { pattern, code, message } of expansionDangerPatterns) {
    if (pattern.test(unquotedContent)) {
      return { kind: "block", code, message };
    }
  }
  return null;
}

export function validateRedirections(ctx: EnterpriseValidationContext): EnterpriseValidatorResult {
  const { fullyUnquotedContent } = ctx;
  if (/</.test(fullyUnquotedContent)) {
    return {
      kind: "block",
      code: "INPUT_REDIRECTION",
      message: "Command contains input redirection (<) which could read sensitive files",
    };
  }
  if (/>/.test(fullyUnquotedContent)) {
    return {
      kind: "block",
      code: "OUTPUT_REDIRECTION",
      message: "Command contains output redirection (>) which could write to arbitrary files",
    };
  }
  return null;
}

export function validateNewlines(ctx: EnterpriseValidationContext): EnterpriseValidatorResult {
  const { fullyUnquotedPreStrip } = ctx;
  if (!/[\n\r]/.test(fullyUnquotedPreStrip)) {
    return null;
  }
  const looksLikeCommand = /(?<![\s]\\)[\n\r]\s*\S/.test(fullyUnquotedPreStrip);
  if (looksLikeCommand) {
    return {
      kind: "block",
      code: "NEWLINE_COMMAND_SPLIT",
      message: "Command contains newlines that could separate multiple commands",
    };
  }
  return null;
}

export function validateCarriageReturn(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  if (!ctx.originalCommand.includes("\r")) {
    return null;
  }
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  for (let i = 0; i < ctx.originalCommand.length; i++) {
    const c = ctx.originalCommand[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\" && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (c === "\r" && !inDoubleQuote) {
      return {
        kind: "block",
        code: "CARRIAGE_RETURN_TOKENIZATION",
        message:
          "Command contains carriage return (\\r) which shell-quote and bash tokenize differently",
      };
    }
  }
  return null;
}

export function validateIFSInjection(ctx: EnterpriseValidationContext): EnterpriseValidatorResult {
  if (/\$IFS|\$\{[^}]*IFS/.test(ctx.originalCommand)) {
    return {
      kind: "block",
      code: "IFS_INJECTION",
      message: "Command contains IFS variable usage which could bypass security validation",
    };
  }
  return null;
}

export function validateProcEnvironAccess(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  if (/\/proc\/.*\/environ/.test(ctx.originalCommand)) {
    return {
      kind: "block",
      code: "PROC_ENVIRON",
      message:
        "Command accesses /proc/*/environ which could expose sensitive environment variables",
    };
  }
  return null;
}

export function validateMalformedTokenInjection(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  const parseResult = tryParseShellCommand(ctx.originalCommand);
  if (!parseResult.success) {
    return {
      kind: "block",
      code: "SHELL_QUOTE_PARSE",
      message: "Command could not be parsed for ambiguous-token safety checks; refusing to execute",
    };
  }
  const parsed = parseResult.tokens;
  const hasCommandSeparator = parsed.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "op" in entry &&
      (entry.op === ";" || entry.op === "&&" || entry.op === "||"),
  );
  if (!hasCommandSeparator) {
    return null;
  }
  if (hasMalformedTokens(ctx.originalCommand, parsed)) {
    return {
      kind: "block",
      code: "MALFORMED_TOKEN_INJECTION",
      message:
        "Command contains ambiguous syntax with command separators that could be misinterpreted",
    };
  }
  return null;
}

function hasBackslashEscapedWhitespace(command: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === "\\" && !inSingleQuote) {
      if (!inDoubleQuote) {
        const nextChar = command[i + 1];
        if (nextChar === " " || nextChar === "\t") {
          return true;
        }
      }
      i++;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
  }
  return false;
}

export function validateBackslashEscapedWhitespace(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  if (hasBackslashEscapedWhitespace(ctx.originalCommand)) {
    return {
      kind: "block",
      code: "BACKSLASH_ESCAPED_WHITESPACE",
      message: "Command contains backslash-escaped whitespace that could alter command parsing",
    };
  }
  return null;
}

function hasBackslashEscapedOperator(command: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === "\\" && !inSingleQuote) {
      if (!inDoubleQuote) {
        const nextChar = command[i + 1];
        if (nextChar && SHELL_OPERATORS.has(nextChar)) {
          return true;
        }
      }
      i++;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
  }
  return false;
}

export function validateBackslashEscapedOperators(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  if (ctx.treeSitter && !ctx.treeSitter.hasActualOperatorNodes) {
    return null;
  }
  if (hasBackslashEscapedOperator(ctx.originalCommand)) {
    return {
      kind: "block",
      code: "BACKSLASH_ESCAPED_OPERATORS",
      message:
        "Command contains a backslash before a shell operator (;, |, &, <, >) which can hide command structure",
    };
  }
  return null;
}

function isEscapedAtPosition(content: string, pos: number): boolean {
  let backslashCount = 0;
  let i = pos - 1;
  while (i >= 0 && content[i] === "\\") {
    backslashCount++;
    i--;
  }
  return backslashCount % 2 === 1;
}

export function validateBraceExpansion(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  const content = ctx.fullyUnquotedPreStrip;
  let unescapedOpenBraces = 0;
  let unescapedCloseBraces = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "{" && !isEscapedAtPosition(content, i)) {
      unescapedOpenBraces++;
    } else if (content[i] === "}" && !isEscapedAtPosition(content, i)) {
      unescapedCloseBraces++;
    }
  }
  if (unescapedOpenBraces > 0 && unescapedCloseBraces > unescapedOpenBraces) {
    return {
      kind: "block",
      code: "BRACE_EXPANSION_OBFUSCATION",
      message:
        "Command has excess closing braces after quote stripping, indicating possible brace expansion obfuscation",
    };
  }
  if (unescapedOpenBraces > 0) {
    const orig = ctx.originalCommand;
    if (/['"][{}]['"]/.test(orig)) {
      return {
        kind: "block",
        code: "BRACE_EXPANSION_QUOTED",
        message:
          "Command contains quoted brace character inside brace context (potential brace expansion obfuscation)",
      };
    }
  }
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "{") continue;
    if (isEscapedAtPosition(content, i)) continue;
    let depth = 1;
    let matchingClose = -1;
    for (let j = i + 1; j < content.length; j++) {
      const ch = content[j]!;
      if (ch === "{" && !isEscapedAtPosition(content, j)) {
        depth++;
      } else if (ch === "}" && !isEscapedAtPosition(content, j)) {
        depth--;
        if (depth === 0) {
          matchingClose = j;
          break;
        }
      }
    }
    if (matchingClose === -1) continue;
    let innerDepth = 0;
    for (let k = i + 1; k < matchingClose; k++) {
      const ch = content[k]!;
      if (ch === "{" && !isEscapedAtPosition(content, k)) {
        innerDepth++;
      } else if (ch === "}" && !isEscapedAtPosition(content, k)) {
        innerDepth--;
      } else if (innerDepth === 0) {
        if (ch === "," || (ch === "." && k + 1 < matchingClose && content[k + 1] === ".")) {
          return {
            kind: "block",
            code: "BRACE_EXPANSION",
            message: "Command contains brace expansion that could alter command parsing",
          };
        }
      }
    }
  }
  return null;
}

export function validateUnicodeWhitespace(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  if (UNICODE_WS_RE.test(ctx.originalCommand)) {
    return {
      kind: "block",
      code: "UNICODE_WHITESPACE",
      message:
        "Command contains Unicode whitespace characters that could cause parsing inconsistencies",
    };
  }
  return null;
}

export function validateMidWordHash(ctx: EnterpriseValidationContext): EnterpriseValidatorResult {
  const { unquotedKeepQuoteChars } = ctx;
  const joined = unquotedKeepQuoteChars.replace(/\\+\n/g, (match) => {
    const backslashCount = match.length - 1;
    return backslashCount % 2 === 1 ? "\\".repeat(backslashCount - 1) : match;
  });
  if (/\S(?<!\$\{)#/.test(unquotedKeepQuoteChars) || /\S(?<!\$\{)#/.test(joined)) {
    return {
      kind: "block",
      code: "MID_WORD_HASH",
      message: "Command contains mid-word # which is parsed differently by shell-quote vs bash",
    };
  }
  return null;
}

export function validateCommentQuoteDesync(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  if (ctx.treeSitter) {
    return null;
  }
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  for (let i = 0; i < ctx.originalCommand.length; i++) {
    const char = ctx.originalCommand[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inDoubleQuote) {
      if (char === '"') inDoubleQuote = false;
      continue;
    }
    if (char === "'") {
      inSingleQuote = true;
      continue;
    }
    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (char === "#") {
      const lineEnd = ctx.originalCommand.indexOf("\n", i);
      const commentText = ctx.originalCommand.slice(
        i + 1,
        lineEnd === -1 ? ctx.originalCommand.length : lineEnd,
      );
      if (/['"]/.test(commentText)) {
        return {
          kind: "block",
          code: "COMMENT_QUOTE_DESYNC",
          message:
            "Command contains quote characters inside a # comment which can desync quote tracking",
        };
      }
      if (lineEnd === -1) break;
      i = lineEnd;
    }
  }
  return null;
}

export function validateQuotedNewline(ctx: EnterpriseValidationContext): EnterpriseValidatorResult {
  if (!ctx.originalCommand.includes("\n") || !ctx.originalCommand.includes("#")) {
    return null;
  }
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  for (let i = 0; i < ctx.originalCommand.length; i++) {
    const char = ctx.originalCommand[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (char === "\n" && (inSingleQuote || inDoubleQuote)) {
      const lineStart = i + 1;
      const nextNewline = ctx.originalCommand.indexOf("\n", lineStart);
      const lineEnd = nextNewline === -1 ? ctx.originalCommand.length : nextNewline;
      const nextLine = ctx.originalCommand.slice(lineStart, lineEnd);
      if (nextLine.trim().startsWith("#")) {
        return {
          kind: "block",
          code: "QUOTED_NEWLINE_HASH",
          message:
            "Command contains a quoted newline followed by a #-prefixed line, which can hide arguments from line-based permission checks",
        };
      }
    }
  }
  return null;
}

export function validateZshDangerousCommands(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  const ZSH_PRECOMMAND_MODIFIERS = new Set(["command", "builtin", "noglob", "nocorrect"]);
  const trimmed = ctx.originalCommand.trim();
  const tokens = trimmed.split(/\s+/);
  let baseCmd = "";
  for (const token of tokens) {
    if (/^[A-Za-z_]\w*=/.test(token)) continue;
    if (ZSH_PRECOMMAND_MODIFIERS.has(token)) continue;
    baseCmd = token;
    break;
  }
  if (ZSH_DANGEROUS_COMMANDS.has(baseCmd)) {
    return {
      kind: "block",
      code: "ZSH_DANGEROUS_COMMAND",
      message: `Command uses Zsh-specific '${baseCmd}' which can bypass security checks`,
    };
  }
  if (baseCmd === "fc" && /\s-\S*e/.test(trimmed)) {
    return {
      kind: "block",
      code: "ZSH_FC_E",
      message: "Command uses 'fc -e' which can execute arbitrary commands via editor",
    };
  }
  return null;
}

export function validateObfuscatedFlags(
  ctx: EnterpriseValidationContext,
): EnterpriseValidatorResult {
  const { originalCommand, baseCommand } = ctx;
  const hasShellOperators = /[|&;]/.test(originalCommand);
  if (baseCommand === "echo" && !hasShellOperators) {
    return null;
  }
  if (/\$'[^']*'/.test(originalCommand)) {
    return {
      kind: "block",
      code: "OBFUSCATED_FLAGS_ANSI_C",
      message: "Command contains ANSI-C quoting which can hide characters",
    };
  }
  if (/\$"[^"]*"/.test(originalCommand)) {
    return {
      kind: "block",
      code: "OBFUSCATED_FLAGS_LOCALE",
      message: "Command contains locale quoting which can hide characters",
    };
  }
  if (/\$['"]{2}\s*-/.test(originalCommand)) {
    return {
      kind: "block",
      code: "OBFUSCATED_FLAGS_EMPTY_QUOTE",
      message: "Command contains empty special quotes before dash (potential bypass)",
    };
  }
  if (/(?:^|\s)(?:''|"")+\s*-/.test(originalCommand)) {
    return {
      kind: "block",
      code: "OBFUSCATED_FLAGS_EMPTY_PAIR",
      message: "Command contains empty quotes before dash (potential bypass)",
    };
  }
  if (/(?:""|'')+['"]-/.test(originalCommand)) {
    return {
      kind: "block",
      code: "OBFUSCATED_FLAGS_ADJACENT_DASH",
      message:
        "Command contains empty quote pair adjacent to quoted dash (potential flag obfuscation)",
    };
  }
  if (/(?:^|\s)['"]{3,}/.test(originalCommand)) {
    return {
      kind: "block",
      code: "OBFUSCATED_FLAGS_MULTI_QUOTE",
      message:
        "Command contains consecutive quote characters at word start (potential obfuscation)",
    };
  }

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < originalCommand.length - 1; i++) {
    const currentChar = originalCommand[i]!;
    const nextChar = originalCommand[i + 1]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (currentChar === "\\" && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }
    if (currentChar && nextChar && /\s/.test(currentChar) && /['"`]/.test(nextChar)) {
      const quoteChar = nextChar;
      let j = i + 2;
      let insideQuote = "";
      while (j < originalCommand.length && originalCommand[j] !== quoteChar) {
        insideQuote += originalCommand[j]!;
        j++;
      }
      const charAfterQuote = originalCommand[j + 1];
      const hasFlagCharsInside = /^-+[a-zA-Z0-9$`]/.test(insideQuote);
      const FLAG_CONTINUATION_CHARS = /[a-zA-Z0-9\\${`-]/;
      const hasFlagCharsContinuing =
        /^-+$/.test(insideQuote) &&
        charAfterQuote !== undefined &&
        FLAG_CONTINUATION_CHARS.test(charAfterQuote);
      const hasFlagCharsInNextQuote =
        (insideQuote === "" || /^-+$/.test(insideQuote)) &&
        charAfterQuote !== undefined &&
        /['"`]/.test(charAfterQuote) &&
        (() => {
          let pos = j + 1;
          let combinedContent = insideQuote;
          while (pos < originalCommand.length && /['"`]/.test(originalCommand[pos]!)) {
            const segQuote = originalCommand[pos]!;
            let end = pos + 1;
            while (end < originalCommand.length && originalCommand[end] !== segQuote) {
              end++;
            }
            const segment = originalCommand.slice(pos + 1, end);
            combinedContent += segment;
            if (/^-+[a-zA-Z0-9$`]/.test(combinedContent)) return true;
            const priorContent =
              segment.length > 0 ? combinedContent.slice(0, -segment.length) : combinedContent;
            if (/^-+$/.test(priorContent)) {
              if (/[a-zA-Z0-9$`]/.test(segment)) return true;
            }
            if (end >= originalCommand.length) break;
            pos = end + 1;
          }
          if (pos < originalCommand.length && FLAG_CONTINUATION_CHARS.test(originalCommand[pos]!)) {
            if (/^-+$/.test(combinedContent) || combinedContent === "") {
              const nextCh = originalCommand[pos]!;
              if (nextCh === "-") {
                return true;
              }
              if (/[a-zA-Z0-9\\${`]/.test(nextCh) && combinedContent !== "") {
                return true;
              }
            }
            if (/^-/.test(combinedContent)) {
              return true;
            }
          }
          return false;
        })();
      if (
        j < originalCommand.length &&
        originalCommand[j] === quoteChar &&
        (hasFlagCharsInside || hasFlagCharsContinuing || hasFlagCharsInNextQuote)
      ) {
        return {
          kind: "block",
          code: "OBFUSCATED_FLAGS_QUOTED",
          message: "Command contains quoted characters in flag names",
        };
      }
    }
    if (currentChar && nextChar && /\s/.test(currentChar) && nextChar === "-") {
      let j = i + 1;
      let flagContent = "";
      while (j < originalCommand.length) {
        const flagChar = originalCommand[j]!;
        if (/[\s=]/.test(flagChar)) {
          break;
        }
        if (/['"`]/.test(flagChar)) {
          if (baseCommand === "cut" && flagContent === "-d" && /['"`]/.test(flagChar)) {
            break;
          }
          if (j + 1 < originalCommand.length) {
            const nextFlagChar = originalCommand[j + 1]!;
            if (nextFlagChar && !/[a-zA-Z0-9_'"-]/.test(nextFlagChar)) {
              break;
            }
          }
        }
        flagContent += flagChar;
        j++;
      }
      if (flagContent.includes('"') || flagContent.includes("'")) {
        return {
          kind: "block",
          code: "OBFUSCATED_FLAGS_INLINE",
          message: "Command contains quoted characters in flag names",
        };
      }
    }
  }

  if (/\s['"`]-/.test(ctx.fullyUnquotedContent)) {
    return {
      kind: "block",
      code: "OBFUSCATED_FLAGS_UNQUOTED_VIEW",
      message: "Command contains quoted characters in flag names",
    };
  }
  if (/['"`]{2}-/.test(ctx.fullyUnquotedContent)) {
    return {
      kind: "block",
      code: "OBFUSCATED_FLAGS_DOUBLE_QUOTE_PREFIX",
      message: "Command contains quoted characters in flag names",
    };
  }
  return null;
}
