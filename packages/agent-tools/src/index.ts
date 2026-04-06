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
  DEFAULT_READ_ONLY_BASH_ALLOWED_PREFIXES,
  createReadOnlyBashTool,
  wrapBashToolReadOnly,
  type CreateReadOnlyBashToolOptions,
  type WrapReadOnlyBashToolOptions,
} from "./bash/read-only-bash-tool";

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

export { createFileEditTool } from "./workspace/file-edit-tool";
export { createFileReadTool, type CreateFileReadToolOptions } from "./workspace/file-read-tool";
export { createFileWriteTool } from "./workspace/file-write-tool";
export { createGlobTool, type CreateGlobToolOptions } from "./workspace/glob-tool";
export { createGrepTool, type CreateGrepToolOptions } from "./workspace/grep-tool";
export { createGitStatusTool } from "./workspace/git-status-tool";
export { createRunChecksTool } from "./workspace/run-checks-tool";
export { createCodingToolset, type CreateCodingToolsetOptions } from "./workspace/coding-toolset";

export {
  createAgentTool,
  createAskUserQuestionTool,
  createBriefTool,
  createConfigTool,
  createDiscoverSkillsTool,
  createEnterPlanModeTool,
  createEnterWorktreeTool,
  createExitPlanModeTool,
  createExitWorktreeTool,
  createSendMessageTool,
  createSkillTool,
  createTaskCreateTool,
  createTaskGetTool,
  createTaskListTool,
  createTaskOutputTool,
  createTaskStopTool,
  createTaskUpdateTool,
  createTeamCreateTool,
  createTeamDeleteTool,
  createTodoWriteTool,
  createToolSearchTool,
} from "./platform/coordination-tools";
export {
  createScheduleCronCreateTool,
  createScheduleCronDeleteTool,
  createScheduleCronListTool,
} from "./platform/schedule-tools";
export {
  createListMcpResourcesTool,
  createMcpAuthTool,
  createMcpTool,
  createReadMcpResourceTool,
  createRemoteTriggerTool,
  createWebFetchTool,
  createWebSearchTool,
} from "./integration/web-tools";
export { createLspTool } from "./integration/lsp-tool";
export { createReplTool } from "./utility/repl-tool";
export { createSyntheticOutputTool } from "./utility/structured-output-tool";
export {
  createNotebookEditTool,
  createPowerShellTool,
  createSleepTool,
} from "./utility/utility-tools";
