import { stripSafeWrappers } from "./permissions";
import { splitShellSegments } from "./security";

function firstTokenAfterEnv(cmd: string): string {
  const tokens = stripSafeWrappers(cmd).trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const assign = /^[A-Za-z_][A-Za-z0-9_]*=/;
  while (i < tokens.length && assign.test(tokens[i]!)) {
    i++;
  }
  return (tokens[i] ?? "").replace(/^\\+/, "").toLowerCase();
}

export function isCdLikeCommand(segment: string): boolean {
  const t = firstTokenAfterEnv(segment);
  return t === "cd" || t === "pushd" || t === "popd";
}

export function isGitCommand(segment: string): boolean {
  const s = stripSafeWrappers(segment).trim();
  if (s.startsWith("git ") || s === "git") {
    return true;
  }
  const t = firstTokenAfterEnv(segment);
  if (t === "xargs") {
    return /\bgit\b/.test(s);
  }
  return false;
}

export type CompoundVerdict = { ok: true } | { ok: false; code: string; message: string };

/** Multiple cd-like in one command list → clarity / safety (matches claude behavior). */
export function evaluateCompoundCommandPolicies(command: string): CompoundVerdict {
  const segments = splitShellSegments(command);
  if (!segments) {
    return {
      ok: false,
      code: "COMPOUND_UNBALANCED",
      message: "Unbalanced quotes in compound command.",
    };
  }
  const cds = segments.filter((s) => isCdLikeCommand(s));
  if (cds.length > 1) {
    return {
      ok: false,
      code: "MULTIPLE_CD",
      message: "Multiple directory changes in one command require splitting for safety.",
    };
  }
  if (cds.length === 1 && segments.some((s) => isGitCommand(s))) {
    return {
      ok: false,
      code: "CD_WITH_GIT",
      message:
        "Compound commands combining cd and git are blocked (bare-repo / cwd-sensitive git edge cases).",
    };
  }
  return { ok: true };
}
