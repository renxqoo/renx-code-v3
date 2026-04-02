import { isAbsolute, normalize, relative, resolve } from "node:path";

export interface BashPathPolicy {
  /** Working directory used to resolve redirect targets. */
  workspaceRoot: string;
  /** When false (default), redirects outside workspaceRoot block execution. */
  allowRedirectOutsideWorkspace?: boolean;
}

const DANGEROUS_PREFIXES = [
  "/etc/",
  "/sys/",
  "/proc/",
  "/dev/",
  "/boot/",
  "/root/",
  "C:\\Windows\\System32",
  "\\\\.\\",
];

function isUnderRoot(path: string, root: string): boolean {
  const absPath = normalize(resolve(path));
  const absRoot = normalize(resolve(root));
  const rel = relative(absRoot, absPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isDangerousRedirectTarget(resolvedPath: string): boolean {
  const n = normalize(resolvedPath).replace(/\\/g, "/");
  if (n === "/" || n.match(/^[A-Za-z]:\/?$/)) {
    return true;
  }
  return DANGEROUS_PREFIXES.some((p) => n.startsWith(p.replace(/\\/g, "/").toLowerCase()));
}

export type PathPolicyVerdict = { ok: true } | { ok: false; code: string; message: string };

export function evaluateRedirectPathPolicy(
  targets: string[],
  cwd: string,
  policy: BashPathPolicy | undefined,
  options: { hasAmbiguousRedirections?: boolean } = {},
): PathPolicyVerdict {
  if (options.hasAmbiguousRedirections) {
    return {
      ok: false,
      code: "REDIRECT_AMBIGUOUS",
      message:
        "Output redirection could not be fully analyzed (heredoc, substitution, or glob). Refusing to execute.",
    };
  }
  if (!policy || targets.length === 0) {
    return { ok: true };
  }

  const root = policy.workspaceRoot;
  const allowOutside = policy.allowRedirectOutsideWorkspace === true;

  for (const t of targets) {
    const abs = isAbsolute(t) ? normalize(resolve(t)) : normalize(resolve(cwd, t));
    if (isDangerousRedirectTarget(abs)) {
      return {
        ok: false,
        code: "REDIRECT_DANGEROUS",
        message: `Redirection targets a sensitive system path: ${abs}`,
      };
    }
    if (!allowOutside && !isUnderRoot(abs, root)) {
      return {
        ok: false,
        code: "REDIRECT_OUTSIDE_WORKSPACE",
        message: `Output redirection escapes workspace (${abs} is outside ${root}).`,
      };
    }
  }

  return { ok: true };
}
