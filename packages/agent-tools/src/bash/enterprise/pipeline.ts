import type { BashSecurityVerdict } from "../security";
import {
  extractQuotedContent,
  resolveBaseCommandWord,
  stripSafeRedirections,
  type EnterpriseValidationContext,
} from "./context";
import { extractHeredocs } from "./heredoc";
import { hasShellQuoteSingleQuoteBug } from "./shell-quote-helpers";
import {
  checkControlCharacters,
  validateBackslashEscapedOperators,
  validateBackslashEscapedWhitespace,
  validateBraceExpansion,
  validateCarriageReturn,
  validateCommentQuoteDesync,
  validateDangerousPatterns,
  validateDangerousVariables,
  validateGitCommit,
  validateIFSInjection,
  validateIncompleteCommands,
  validateJqCommand,
  validateMalformedTokenInjection,
  validateMidWordHash,
  validateNewlines,
  validateObfuscatedFlags,
  validateProcEnvironAccess,
  validateQuotedNewline,
  validateSafeCommandSubstitution,
  validateShellMetacharacters,
  validateUnicodeWhitespace,
  validateZshDangerousCommands,
  type EnterpriseValidatorResult,
} from "./validators";

export type EnterpriseDeepOptions = {
  maxRecursionDepth?: number;
  treeSitter?: EnterpriseValidationContext["treeSitter"];
};

const DEFAULT_MAX_DEPTH = 10;

function verdictFromEnterprise(r: Exclude<EnterpriseValidatorResult, null>): BashSecurityVerdict {
  if (r.kind === "allow_early") {
    return { ok: true };
  }
  return { ok: false, code: r.code, message: r.message };
}

function buildContext(
  originalCommand: string,
  processedCommand: string,
  checkRemainder: (cmd: string) => BashSecurityVerdict,
  treeSitter: EnterpriseDeepOptions["treeSitter"],
): EnterpriseValidationContext {
  const baseCommand = resolveBaseCommandWord(originalCommand);
  const { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars } = extractQuotedContent(
    processedCommand,
    baseCommand === "jq",
  );
  return {
    originalCommand,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
    checkRemainder,
    treeSitter: treeSitter ?? null,
  };
}

/**
 * Enterprise / Claude-parity deep static checks: control chars, heredoc-aware
 * quote extraction, shell-quote differential guards, obfuscated flags, etc.
 * Runs before shallow segment allowlists in `assessBashCommand`.
 */
export function runEnterpriseDeepSecurity(
  command: string,
  options: EnterpriseDeepOptions = {},
): BashSecurityVerdict {
  const maxDepth = options.maxRecursionDepth ?? DEFAULT_MAX_DEPTH;
  const treeSitter = options.treeSitter;

  const inner = (cmd: string, depth: number): BashSecurityVerdict => {
    if (depth > maxDepth) {
      return {
        ok: false,
        code: "ENTERPRISE_RECURSION_LIMIT",
        message: "Security validation recursion limit exceeded (nested safe heredoc checks).",
      };
    }

    const checkRemainder = (c: string) => inner(c, depth + 1);

    const ctrl = checkControlCharacters(cmd);
    if (ctrl) {
      return verdictFromEnterprise(ctrl);
    }

    if (hasShellQuoteSingleQuoteBug(cmd)) {
      return {
        ok: false,
        code: "SHELL_QUOTE_SINGLEQUOTE_BUG",
        message:
          "Command contains single-quoted backslash pattern that could bypass security checks",
      };
    }

    const { processedCommand } = extractHeredocs(cmd, { quotedOnly: true });

    const earlyCtx = buildContext(cmd, processedCommand, checkRemainder, treeSitter);

    const earlyChecks = [
      validateIncompleteCommands,
      validateSafeCommandSubstitution,
      validateGitCommit,
    ] as const;
    for (const fn of earlyChecks) {
      const r = fn(earlyCtx);
      if (r?.kind === "allow_early") {
        return { ok: true };
      }
      if (r?.kind === "block") {
        return verdictFromEnterprise(r);
      }
    }

    const context = earlyCtx;

    const mainValidators = [
      validateJqCommand,
      validateObfuscatedFlags,
      validateShellMetacharacters,
      validateDangerousVariables,
      validateCommentQuoteDesync,
      validateQuotedNewline,
      validateCarriageReturn,
      validateNewlines,
      validateIFSInjection,
      validateProcEnvironAccess,
      validateDangerousPatterns,
      validateBackslashEscapedWhitespace,
      validateBackslashEscapedOperators,
      validateUnicodeWhitespace,
      validateMidWordHash,
      validateBraceExpansion,
      validateZshDangerousCommands,
      validateMalformedTokenInjection,
    ] as const;

    for (const fn of mainValidators) {
      const r = fn(context);
      if (!r) continue;
      if (r.kind === "block") {
        return verdictFromEnterprise(r);
      }
    }
    return { ok: true };
  };

  return inner(command, 0);
}
