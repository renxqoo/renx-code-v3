import { parse as shellQuoteParse, type ParseEntry } from "shell-quote";

export type ShellParseResult =
  | { success: true; tokens: ParseEntry[] }
  | { success: false; error: string };

export function tryParseShellCommand(cmd: string): ShellParseResult {
  try {
    const tokens = shellQuoteParse(cmd);
    return { success: true, tokens };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "Unknown parse error",
    };
  }
}

export function hasMalformedTokens(command: string, parsed: ParseEntry[]): boolean {
  let inSingle = false;
  let inDouble = false;
  let doubleCount = 0;
  let singleCount = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (c === '"' && !inSingle) {
      doubleCount++;
      inDouble = !inDouble;
    } else if (c === "'" && !inDouble) {
      singleCount++;
      inSingle = !inSingle;
    }
  }
  if (doubleCount % 2 !== 0 || singleCount % 2 !== 0) return true;

  for (const entry of parsed) {
    if (typeof entry !== "string") continue;

    const openBraces = (entry.match(/{/g) || []).length;
    const closeBraces = (entry.match(/}/g) || []).length;
    if (openBraces !== closeBraces) return true;

    const openParens = (entry.match(/\(/g) || []).length;
    const closeParens = (entry.match(/\)/g) || []).length;
    if (openParens !== closeParens) return true;

    const openBrackets = (entry.match(/\[/g) || []).length;
    const closeBrackets = (entry.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) return true;

    const doubleQuotes = entry.match(/(?<!\\)"/g) || [];
    if (doubleQuotes.length % 2 !== 0) return true;

    const singleQuotes = entry.match(/(?<!\\)'/g) || [];
    if (singleQuotes.length % 2 !== 0) return true;
  }
  return false;
}

export function hasShellQuoteSingleQuoteBug(command: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;

    if (char === "\\" && !inSingleQuote) {
      i++;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;

      if (!inSingleQuote) {
        let backslashCount = 0;
        let j = i - 1;
        while (j >= 0 && command[j] === "\\") {
          backslashCount++;
          j--;
        }
        if (backslashCount > 0 && backslashCount % 2 === 1) {
          return true;
        }
        if (backslashCount > 0 && backslashCount % 2 === 0 && command.indexOf("'", i + 1) !== -1) {
          return true;
        }
      }
      continue;
    }
  }

  return false;
}
