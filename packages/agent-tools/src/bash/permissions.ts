/**
 * Permission-style rule matching (headless analogue of Bash allow/deny/ask rules).
 * Rules are evaluated on stripped/normalized command strings; deny beats ask beats allow.
 *
 * **Use {@link BashPermissionPolicy}** in the agent Runtime so allow/deny/ask run once before
 * `invoke`. Do not duplicate rules inside `createBashTool`.
 */

const SAFE_ENV_NAMES = new Set([
  "GOOS",
  "GOARCH",
  "CGO_ENABLED",
  "GO111MODULE",
  "NODE_ENV",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
]);

/** Leading VAR=value only if var is in SAFE_ENV_NAMES (compare claude stripSafeWrappers phase 1 idea). */
export function stripSafeWrappers(command: string): string {
  let s = stripFullLineComments(command);
  const ENV = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/;
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = stripFullLineComments(s);
    const m = s.match(ENV);
    if (m?.[1] && SAFE_ENV_NAMES.has(m[1])) {
      s = s.replace(ENV, "");
    }
  }
  const WRAPPERS = [
    /^timeout[ \t]+(?:-\S+[ \t]+)*\d+(?:\.\d+)?[smhd]?[ \t]+/,
    /^time[ \t]+(?:--[ \t]+)?/,
    /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
    /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
    /^nohup[ \t]+(?:--[ \t]+)?/,
  ];
  prev = "";
  while (s !== prev) {
    prev = s;
    s = stripFullLineComments(s);
    for (const re of WRAPPERS) {
      s = s.replace(re, "");
    }
  }
  return s.trim();
}

function stripFullLineComments(cmd: string): string {
  const lines = cmd.split("\n");
  const kept = lines.filter((line) => {
    const t = line.trim();
    return t.length > 0 && !t.startsWith("#");
  });
  return kept.length === 0 ? cmd : kept.join("\n");
}

export function matchWildcardPattern(pattern: string, command: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(command);
}

export type BashRuleEffect = "allow" | "deny" | "ask";

export interface BashNamedRule {
  effect: BashRuleEffect;
  /** `exact` | `prefix` | `glob` */
  mode: "exact" | "prefix" | "glob";
  value: string;
}

export interface BashPermissionRules {
  /** Explicit ordered rules; first matching deny/ask wins, then allow applies for lockdown. */
  rules?: BashNamedRule[];
  /**
   * When true and at least one `allow` rule exists, command must match some allow rule
   * after deny/ask resolution (enterprise lockdown).
   */
  requireAllowMatchWhenPresent?: boolean;
}

function ruleMatches(mode: BashNamedRule["mode"], value: string, command: string): boolean {
  const cmd = command.trim();
  const v = value.trim();
  switch (mode) {
    case "exact":
      return cmd === v;
    case "prefix":
      return cmd === v || cmd.startsWith(`${v} `);
    case "glob":
      return matchWildcardPattern(v, cmd);
    default:
      return false;
  }
}

export type BashPermissionVerdict =
  | { ok: true }
  | { ok: false; effect: "deny" | "ask"; code: string; message: string };

/**
 * @param command - raw user command
 * @param rules - optional rule set; missing/empty → always ok
 */
export function evaluatePermissionRules(
  command: string,
  rules: BashPermissionRules | undefined,
): BashPermissionVerdict {
  if (!rules?.rules?.length) {
    return { ok: true };
  }
  const stripped = stripSafeWrappers(command);
  const candidates = [command.trim(), stripped].filter((s, i, a) => a.indexOf(s) === i);

  for (const cmd of candidates) {
    for (const r of rules.rules) {
      if (r.effect === "deny" && ruleMatches(r.mode, r.value, cmd)) {
        return {
          ok: false,
          effect: "deny",
          code: "RULE_DENY",
          message: `Denied by bash rule (${r.mode}: ${r.value}).`,
        };
      }
    }
  }

  for (const cmd of candidates) {
    for (const r of rules.rules) {
      if (r.effect === "ask" && ruleMatches(r.mode, r.value, cmd)) {
        return {
          ok: false,
          effect: "ask",
          code: "RULE_ASK",
          message: `Command requires approval per bash rule (${r.mode}: ${r.value}).`,
        };
      }
    }
  }

  const allowRules = rules.rules.filter((r) => r.effect === "allow");
  if (rules.requireAllowMatchWhenPresent && allowRules.length > 0) {
    const matched = candidates.some((cmd) =>
      allowRules.some((r) => ruleMatches(r.mode, r.value, cmd)),
    );
    if (!matched) {
      return {
        ok: false,
        effect: "deny",
        code: "RULE_ALLOW_LOCKDOWN",
        message: "Command does not match any allow rule (lockdown mode).",
      };
    }
  }

  return { ok: true };
}
