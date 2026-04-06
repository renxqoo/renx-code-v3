import type { AgentTool } from "@renx/agent";
import { createCodingToolset, wrapBashToolReadOnly } from "@renx/agent-tools";

const EXPLORE_TOOL_NAMES = new Set(["Read", "Glob", "Grep", "git_status", "Bash"]);
const PLAN_TOOL_NAMES = new Set(["Read", "Glob", "Grep", "git_status", "Bash"]);
const VERIFICATION_TOOL_NAMES = new Set([
  "Read",
  "Glob",
  "Grep",
  "git_status",
  "run_checks",
  "Bash",
]);

const EXPLORE_BASH_DESCRIPTION =
  "Execute read-only shell commands for repo inspection and search only. Allowed uses include ls, git status, git log, git diff, find, grep, cat, head, and tail. Do not run commands that write files, install dependencies, change git state, or mutate the environment.";

export const resolveCodingToolset = (tools?: AgentTool[]): AgentTool[] =>
  tools ?? createCodingToolset();

const wrapReadOnlyBashIfNeeded = (tool: AgentTool): AgentTool =>
  tool.name === "Bash"
    ? wrapBashToolReadOnly(tool, {
        description: EXPLORE_BASH_DESCRIPTION,
      })
    : tool;

const filterTools = (
  tools: AgentTool[],
  allowedNames: ReadonlySet<string>,
  options?: { readOnlyBash?: boolean },
): AgentTool[] =>
  tools
    .filter((tool) => allowedNames.has(tool.name))
    .map((tool) => (options?.readOnlyBash ? wrapReadOnlyBashIfNeeded(tool) : tool));

export const selectGeneralPurposeTools = (tools: AgentTool[]): AgentTool[] => [...tools];

export const selectExploreTools = (tools: AgentTool[]): AgentTool[] =>
  filterTools(tools, EXPLORE_TOOL_NAMES, { readOnlyBash: true });

export const selectPlanTools = (tools: AgentTool[]): AgentTool[] =>
  filterTools(tools, PLAN_TOOL_NAMES, { readOnlyBash: true });

export const selectVerificationTools = (tools: AgentTool[]): AgentTool[] =>
  filterTools(tools, VERIFICATION_TOOL_NAMES);
