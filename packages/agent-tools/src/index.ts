/**
 * Built-in tools for @renx/agent (enterprise SDK).
 */

export {
  BASH_TOOL_DEFAULT_DESCRIPTION,
  createBashTool,
  type BashResultStorageOptions,
  type BashToolInput,
  type BashTreeSitterOptions,
  type CreateBashToolOptions,
} from "./bash/bash-tool";

export {
  parseForSecurityFromAst,
  resetParserForTests,
  resolveDefaultBashWasmPath,
  type ParseForSecurityResult,
  type TreeSitterBashPaths,
} from "./bash/ast-security";

export { detectImageFromStdout, type DetectedImage } from "./bash/image-output";

export {
  spillTextIfLarge,
  writeBinaryArtifact,
  type SpillTextResult,
  type BinaryArtifactResult,
  type ToolResultStorageOptions,
} from "./bash/tool-result-storage";

export {
  assessBashCommand,
  defaultBashSecurityConfig,
  mergeBashSecurityConfig,
  splitShellSegments,
  type BashSecurityConfig,
  type BashSecurityVerdict,
} from "./bash/security";

export {
  defaultExtraDangerPatterns,
  expansionDangerPatterns,
  shallowOnlyDangerPatterns,
  type DangerPatternDef,
} from "./bash/danger-patterns";

export { runEnterpriseDeepSecurity, type EnterpriseDeepOptions } from "./bash/enterprise/pipeline";

export {
  evaluatePermissionRules,
  matchWildcardPattern,
  stripSafeWrappers,
  type BashNamedRule,
  type BashPermissionRules,
  type BashPermissionVerdict,
  type BashRuleEffect,
} from "./bash/permissions";

export {
  BashPermissionPolicy,
  bashVerdictToPolicySignals,
  type BashPermissionPolicyOptions,
} from "./bash/bash-permission-policy";

export { extractOutputRedirectTargets, type RedirectExtractResult } from "./bash/redirects";

export {
  evaluateRedirectPathPolicy,
  isDangerousRedirectTarget,
  type BashPathPolicy,
  type PathPolicyVerdict,
} from "./bash/path-policy";

export {
  evaluateCompoundCommandPolicies,
  isCdLikeCommand,
  isGitCommand,
  type CompoundVerdict,
} from "./bash/compound";

export {
  evaluatePipelineAndRedirects,
  splitPipeSegments,
  type PipelineCheckOptions,
  type PipelineVerdict,
} from "./bash/operators";
