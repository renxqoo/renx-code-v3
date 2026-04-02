/**
 * Single source of truth for regexp danger rules shared between:
 * - `security.ts` — tests the **raw** command string (`extraDangerPatterns`)
 * - `enterprise/validators.ts` — tests **unquoted** content after quote/heredoc preprocessing
 */

export interface DangerPatternDef {
  readonly pattern: RegExp;
  readonly code: string;
  readonly message: string;
}

/**
 * Patterns that are only meaningful on the full raw command (multi-token sequences, URLs).
 */
export const shallowOnlyDangerPatterns: readonly DangerPatternDef[] = [
  {
    pattern: /\b(?:bash|sh|zsh|fish|dash|rbash)\b[^\n|;]*\s+-c\b/,
    code: "SHELL_INLINE",
    message: "Inline shell (-c) is blocked; use a script file or a concrete binary invocation.",
  },
  {
    pattern: /\bcurl\b.+\|\s*(?:sh|bash|zsh|fish)\b/,
    code: "CURL_PIPE_SHELL",
    message: "Piping curl/wget into a shell is blocked.",
  },
  {
    pattern: /\bwget\b.+\|\s*(?:sh|bash|zsh|fish)\b/,
    code: "WGET_PIPE_SHELL",
    message: "Piping wget into a shell is blocked.",
  },
  {
    pattern: /;\s*(?:sudo|doas)\b/,
    code: "PRIV_ESC_CHAIN",
    message: "Chained privilege elevation is blocked.",
  },
  {
    pattern: /\$\([^)]*<</,
    code: "HEREDOC_IN_SUB",
    message: "Heredoc inside command substitution is blocked.",
  },
];

/**
 * Expansion / substitution family — same RegExp + codes for shallow (raw) and deep (unquoted).
 */
export const expansionDangerPatterns: readonly DangerPatternDef[] = [
  { pattern: /\$\(/, code: "SUBSHELL", message: "Command substitution $() is not allowed." },
  {
    pattern: /\$\{/,
    code: "PARAM_EXPANSION",
    message: "Parameter expansion ${} is not allowed.",
  },
  { pattern: /<\(/, code: "PROC_SUB_IN", message: "Process substitution <() is not allowed." },
  { pattern: />\(/, code: "PROC_SUB_OUT", message: "Process substitution >() is not allowed." },
  {
    pattern: /=\(/,
    code: "ZSH_PROC_SUB_EQUALS",
    message: "Zsh process substitution =() is not allowed.",
  },
  {
    pattern: /(?:^|[\s;&|])=[a-zA-Z_]/,
    code: "ZSH_EQUALS",
    message: "Zsh-style =cmd expansion is blocked.",
  },
  { pattern: /\$\[/, code: "ARITH_LEGACY", message: "Arithmetic expansion $[] is blocked." },
  {
    pattern: /~\[/,
    code: "ZSH_TILDE_BRACKET",
    message: "Zsh-style ~[] parameter expansion is not allowed.",
  },
  {
    pattern: /\(e:/,
    code: "ZSH_GLOB_QUALIFIER_E",
    message: "Zsh-style (e:) glob qualifiers are not allowed.",
  },
  {
    pattern: /\(\+/,
    code: "ZSH_GLOB_QUALIFIER_PLUS",
    message: "Zsh glob qualifier with command execution is not allowed.",
  },
  {
    pattern: /\}\s*always\s*\{/,
    code: "ZSH_ALWAYS_BLOCK",
    message: "Zsh always block (try/always construct) is not allowed.",
  },
  {
    pattern: /<\#/,
    code: "PS_COMMENT",
    message: "PowerShell-style <# comment / injection pattern blocked.",
  },
  {
    pattern: /(?:^|[\s;&|])IFS=/,
    code: "IFS_INJECTION",
    message: "IFS assignment is blocked.",
  },
  {
    pattern: /\bzmodload\b/,
    code: "ZSH_ZMODLOAD",
    message: "zmodload is blocked.",
  },
];

/** Default `extraDangerPatterns`: shallow-only rules, then expansion rules (raw string). */
export const defaultExtraDangerPatterns: readonly DangerPatternDef[] = [
  ...shallowOnlyDangerPatterns,
  ...expansionDangerPatterns,
];
