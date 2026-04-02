import { evaluateCompoundCommandPolicies } from "./compound";
import { extractOutputRedirectTargets } from "./redirects";
import { evaluateRedirectPathPolicy, type BashPathPolicy } from "./path-policy";

/**
 * Quote-aware split on top-level `|` (pipe segments).
 */
export function splitPipeSegments(command: string): string[] | null {
  const segments: string[] = [];
  let buf = "";
  let i = 0;
  let single = false;
  let double = false;
  let escape = false;

  const flush = (): void => {
    const t = buf.trim();
    if (t.length > 0) {
      segments.push(t);
    }
    buf = "";
  };

  while (i < command.length) {
    const c = command[i]!;
    if (escape) {
      buf += c;
      escape = false;
      i++;
      continue;
    }
    if (!double && c === "\\") {
      buf += c;
      escape = true;
      i++;
      continue;
    }
    if (!double && c === "'") {
      single = !single;
      buf += c;
      i++;
      continue;
    }
    if (!single && c === '"') {
      double = !double;
      buf += c;
      i++;
      continue;
    }
    if (!single && !double && c === "|") {
      flush();
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  flush();

  if (single || double) {
    return null;
  }
  return segments;
}

/** Detects a balanced top-level subshell / group `( … )` (not `$(…)`). */
function hasTopLevelSubshellParens(command: string): boolean {
  // `$(( arithmetic ))` uses `((` — not a command group; skip to avoid false positives.
  if (command.includes("$((")) {
    return false;
  }
  let depth = 0;
  let single = false;
  let double = false;
  let escape = false;
  let sawSubshell = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (!double && c === "\\") {
      escape = true;
      continue;
    }
    if (!double && c === "'") {
      single = !single;
      continue;
    }
    if (!single && c === '"') {
      double = !double;
      continue;
    }
    if (single || double) {
      continue;
    }
    if (c === "(") {
      if (i > 0 && command[i - 1] === "$") {
        continue;
      }
      if (depth === 0) {
        sawSubshell = true;
      }
      depth++;
    } else if (c === ")" && depth > 0) {
      depth--;
    }
  }
  return sawSubshell && depth === 0;
}

export type PipelineCheckOptions = {
  pathPolicy?: BashPathPolicy;
  cwdForPaths: string;
  /** When true, reject subshell parens `( cmd )` at top level (conservative). */
  blockSubshellParens?: boolean;
};

export type PipelineVerdict = { ok: true } | { ok: false; code: string; message: string };

/**
 * Validates pipes + per-segment static checks + redirect policy on original command.
 */
export function evaluatePipelineAndRedirects(
  command: string,
  opts: PipelineCheckOptions,
): PipelineVerdict {
  if (opts.blockSubshellParens !== false && hasTopLevelSubshellParens(command)) {
    return {
      ok: false,
      code: "SUBSHELL_PARENS",
      message: "Subshell parentheses require manual review; refusing automatic execution.",
    };
  }

  const compound = evaluateCompoundCommandPolicies(command);
  if (!compound.ok) {
    return compound;
  }

  const pipes = splitPipeSegments(command);
  if (!pipes) {
    return {
      ok: false,
      code: "PIPE_UNBALANCED",
      message: "Unbalanced quotes in piped command.",
    };
  }

  for (const seg of pipes) {
    const segCompound = evaluateCompoundCommandPolicies(seg);
    if (!segCompound.ok) {
      return segCompound;
    }
  }

  const { targets, hasAmbiguousRedirections } = extractOutputRedirectTargets(command);
  const pathV = evaluateRedirectPathPolicy(targets, opts.cwdForPaths, opts.pathPolicy, {
    hasAmbiguousRedirections,
  });
  if (!pathV.ok) {
    return pathV;
  }

  return { ok: true };
}
