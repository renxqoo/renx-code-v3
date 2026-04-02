import type { BashSecurityVerdict } from "../security";

export const HEREDOC_IN_SUBSTITUTION = /\$\([^)]*<</;

/**
 * Provably-safe $(cat <<'DELIM'...) pattern; remainder must pass full security recurse.
 */
export function isSafeHeredoc(
  command: string,
  checkRemainder: (c: string) => BashSecurityVerdict,
): boolean {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) return false;

  const heredocPattern = /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g;
  let match: RegExpExecArray | null;
  type HeredocMatch = {
    start: number;
    operatorEnd: number;
    delimiter: string;
    isDash: boolean;
  };
  const safeHeredocs: HeredocMatch[] = [];

  while ((match = heredocPattern.exec(command)) !== null) {
    const delimiter = match[2] || match[3];
    if (delimiter) {
      safeHeredocs.push({
        start: match.index,
        operatorEnd: match.index + match[0].length,
        delimiter,
        isDash: match[1] === "-",
      });
    }
  }

  if (safeHeredocs.length === 0) return false;

  type VerifiedHeredoc = { start: number; end: number };
  const verified: VerifiedHeredoc[] = [];

  for (const { start, operatorEnd, delimiter, isDash } of safeHeredocs) {
    const afterOperator = command.slice(operatorEnd);
    const openLineEnd = afterOperator.indexOf("\n");
    if (openLineEnd === -1) return false;
    const openLineTail = afterOperator.slice(0, openLineEnd);
    if (!/^[ \t]*$/.test(openLineTail)) return false;

    const bodyStart = operatorEnd + openLineEnd + 1;
    const body = command.slice(bodyStart);
    const bodyLines = body.split("\n");

    let closingLineIdx = -1;
    let closeParenLineIdx = -1;
    let closeParenColIdx = -1;

    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!;
      const line = isDash ? rawLine.replace(/^\t*/, "") : rawLine;

      if (line === delimiter) {
        closingLineIdx = i;
        const nextLine = bodyLines[i + 1];
        if (nextLine === undefined) return false;
        const parenMatch = nextLine.match(/^([ \t]*)\)/);
        if (!parenMatch) return false;
        closeParenLineIdx = i + 1;
        closeParenColIdx = parenMatch[1]!.length;
        break;
      }

      if (line.startsWith(delimiter)) {
        const afterDelim = line.slice(delimiter.length);
        const parenMatch = afterDelim.match(/^([ \t]*)\)/);
        if (parenMatch) {
          closingLineIdx = i;
          closeParenLineIdx = i;
          const tabPrefix = isDash ? (rawLine.match(/^\t*/)?.[0] ?? "") : "";
          closeParenColIdx = tabPrefix.length + delimiter.length + parenMatch[1]!.length;
          break;
        }
        if (/^[)}`|&;(<>]/.test(afterDelim)) {
          return false;
        }
      }
    }

    if (closingLineIdx === -1) return false;

    let endPos = bodyStart;
    for (let i = 0; i < closeParenLineIdx; i++) {
      endPos += bodyLines[i]!.length + 1;
    }
    endPos += closeParenColIdx + 1;

    verified.push({ start, end: endPos });
  }

  for (const outer of verified) {
    for (const inner of verified) {
      if (inner === outer) continue;
      if (inner.start > outer.start && inner.start < outer.end) {
        return false;
      }
    }
  }

  const sortedVerified = [...verified].sort((a, b) => b.start - a.start);
  let remaining = command;
  for (const { start, end } of sortedVerified) {
    remaining = remaining.slice(0, start) + remaining.slice(end);
  }

  const trimmedRemaining = remaining.trim();
  if (trimmedRemaining.length > 0) {
    const firstHeredocStart = Math.min(...verified.map((v) => v.start));
    const prefix = command.slice(0, firstHeredocStart);
    if (prefix.trim().length === 0) {
      return false;
    }
  }

  if (!/^[a-zA-Z0-9 \t"'.\-/_@=,:+~]*$/.test(remaining)) return false;

  if (!checkRemainder(remaining).ok) return false;

  return true;
}
