/**
 * Static bash command assessment — defense in depth before backend.exec.
 * Combines enterprise deep checks (Claude-parity) with segment allowlists.
 */
import { defaultExtraDangerPatterns } from "./danger-patterns";
import { runEnterpriseDeepSecurity } from "./enterprise/pipeline";

export type BashSecurityVerdict = { ok: true } | { ok: false; code: string; message: string };

export interface BashSecurityConfig {
  /** Maximum serialized command length (characters). */
  maxCommandLength: number;
  /** Reject if quoting appears unbalanced after scan. */
  rejectUnbalancedQuotes: boolean;
  /**
   * Blocked first token after leading `VAR=value` assignments (compare normalized).
   * Use lowercase for comparison.
   */
  blockedBaseCommands: ReadonlySet<string>;
  /** Extra regexp checks; if any matches, command is blocked. */
  extraDangerPatterns: ReadonlyArray<{ pattern: RegExp; code: string; message: string }>;
  /**
   * When non-empty, every list segment must start with one of these prefixes
   * (after env stripping). Enterprise lock-down mode.
   */
  allowedCommandPrefixes: readonly string[];
  /**
   * When true, run Claude-parity deep checks (obfuscated flags, brace expansion,
   * jq hardening, malformed tokens with shell-quote, /proc/environ, etc.).
   * Default false — only `extraDangerPatterns`, segment rules, and base blocklist apply.
   */
  enterpriseDeepSecurity: boolean;
}

/** First-token blocklist after env assignments (lowercase). Extend via `mergeBashSecurityConfig`. */
const DEFAULT_BLOCKED = new Set([
  "eval",
  "exec",
  "source",
  ".",
  "sudo",
  "doas",
  "pkexec",
  "rbash",
  "zmodload",
]);

export const defaultBashSecurityConfig: BashSecurityConfig = {
  maxCommandLength: 100_000,
  rejectUnbalancedQuotes: true,
  blockedBaseCommands: new Set(DEFAULT_BLOCKED),
  extraDangerPatterns: defaultExtraDangerPatterns,
  allowedCommandPrefixes: [],
  enterpriseDeepSecurity: false,
};

export function mergeBashSecurityConfig(partial?: Partial<BashSecurityConfig>): BashSecurityConfig {
  if (!partial) {
    return {
      ...defaultBashSecurityConfig,
      blockedBaseCommands: new Set(defaultBashSecurityConfig.blockedBaseCommands),
      extraDangerPatterns: [...defaultBashSecurityConfig.extraDangerPatterns],
    };
  }
  return {
    maxCommandLength: partial.maxCommandLength ?? defaultBashSecurityConfig.maxCommandLength,
    rejectUnbalancedQuotes:
      partial.rejectUnbalancedQuotes ?? defaultBashSecurityConfig.rejectUnbalancedQuotes,
    blockedBaseCommands: partial.blockedBaseCommands
      ? new Set(partial.blockedBaseCommands)
      : new Set(defaultBashSecurityConfig.blockedBaseCommands),
    extraDangerPatterns: partial.extraDangerPatterns ?? [
      ...defaultBashSecurityConfig.extraDangerPatterns,
    ],
    allowedCommandPrefixes:
      partial.allowedCommandPrefixes ?? defaultBashSecurityConfig.allowedCommandPrefixes,
    enterpriseDeepSecurity:
      partial.enterpriseDeepSecurity ?? defaultBashSecurityConfig.enterpriseDeepSecurity,
  };
}

function hasUnescapedBacktick(command: string): boolean {
  let i = 0;
  while (i < command.length) {
    if (command[i] === "\\" && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (command[i] === "`") {
      return true;
    }
    i++;
  }
  return false;
}

function quotesBalanced(command: string): boolean {
  let single = false;
  let double = false;
  let escape = false;
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
  }
  return !single && !double;
}

/**
 * Split on top-level `&&`, `||`, `|`, `;`, newlines. Returns null if quotes are unbalanced.
 */
export function splitShellSegments(command: string): string[] | null {
  if (!quotesBalanced(command)) {
    return null;
  }
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
    if (!single && !double) {
      if (command.startsWith("&&", i)) {
        flush();
        i += 2;
        continue;
      }
      if (command.startsWith("||", i)) {
        flush();
        i += 2;
        continue;
      }
      if (c === "|" || c === ";" || c === "\n") {
        flush();
        i++;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return segments;
}

function stripLeadingAssignments(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const assign = /^[A-Za-z_][A-Za-z0-9_]*=/;
  while (i < tokens.length && assign.test(tokens[i]!)) {
    i++;
  }
  return tokens.slice(i).join(" ");
}

function baseCommandToken(command: string): string {
  const head = stripLeadingAssignments(command);
  const m = head.match(/^([^\s/\\]+)/);
  const raw = m?.[1] ?? "";
  return raw.replace(/^\\+/, "").toLowerCase();
}

export function assessBashCommand(
  command: string,
  config: BashSecurityConfig = mergeBashSecurityConfig(),
): BashSecurityVerdict {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "EMPTY", message: "Command is empty." };
  }
  if (trimmed.length > config.maxCommandLength) {
    return {
      ok: false,
      code: "TOO_LONG",
      message: `Command exceeds maximum length (${config.maxCommandLength}).`,
    };
  }
  if (config.rejectUnbalancedQuotes && !quotesBalanced(trimmed)) {
    return {
      ok: false,
      code: "UNBALANCED_QUOTES",
      message: "Unbalanced quotes; refusing to execute.",
    };
  }

  if (config.enterpriseDeepSecurity) {
    const enterprise = runEnterpriseDeepSecurity(trimmed);
    if (!enterprise.ok) {
      return enterprise;
    }
  }

  if (hasUnescapedBacktick(trimmed)) {
    return {
      ok: false,
      code: "BACKTICK",
      message: "Backtick command substitution is not allowed.",
    };
  }
  for (const { pattern, code, message } of config.extraDangerPatterns) {
    if (pattern.test(trimmed)) {
      return { ok: false, code, message };
    }
  }

  const segments = splitShellSegments(trimmed);
  if (segments === null) {
    return {
      ok: false,
      code: "PARSE_SEGMENTS",
      message: "Could not safely segment command (unbalanced quotes).",
    };
  }

  for (const seg of segments) {
    const base = baseCommandToken(seg);
    if (base.length === 0) {
      continue;
    }
    if (config.blockedBaseCommands.has(base)) {
      return {
        ok: false,
        code: "BLOCKED_COMMAND",
        message: `Base command "${base}" is blocked by security policy.`,
      };
    }
    if (config.allowedCommandPrefixes.length > 0) {
      const normalized = stripLeadingAssignments(seg);
      const allowed = config.allowedCommandPrefixes.some((p) =>
        normalized.toLowerCase().startsWith(p.toLowerCase()),
      );
      if (!allowed) {
        return {
          ok: false,
          code: "PREFIX_DENY",
          message: "Command is not on the allowed-prefix list.",
        };
      }
    }
  }

  return { ok: true };
}
