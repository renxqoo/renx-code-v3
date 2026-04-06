import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAgentTool,
  createAskUserQuestionTool,
  createBashTool,
  createBriefTool,
  createConfigTool,
  createEnterPlanModeTool,
  createEnterWorktreeTool,
  createExitPlanModeTool,
  createExitWorktreeTool,
  createFileEditTool,
  createFileReadTool,
  createFileWriteTool,
  createGitStatusTool,
  createGlobTool,
  createGrepTool,
  createListMcpResourcesTool,
  createLspTool,
  createMcpAuthTool,
  createMcpTool,
  createNotebookEditTool,
  createPowerShellTool,
  createRemoteTriggerTool,
  createReplTool,
  createRunChecksTool,
  createScheduleCronCreateTool,
  createScheduleCronDeleteTool,
  createScheduleCronListTool,
  createSendMessageTool,
  createSkillTool,
  createSleepTool,
  createSyntheticOutputTool,
  createTaskCreateTool,
  createTaskGetTool,
  createTaskListTool,
  createTaskOutputTool,
  createTaskStopTool,
  createTaskUpdateTool,
  createTeamCreateTool,
  createTeamDeleteTool,
  createToolSearchTool,
  createTodoWriteTool,
  createWebFetchTool,
  createWebSearchTool,
  createReadMcpResourceTool,
} from "../src/index";

const getSchemaKeys = (schema: unknown): string[] => {
  expect(schema).toBeInstanceOf(z.ZodObject);
  return Object.keys((schema as z.ZodObject<any>).shape);
};

describe("Claude-style tool contract parity", () => {
  it("aligns workspace tool names, descriptions, and input fields", () => {
    const readTool = createFileReadTool();
    expect(readTool.name).toBe("Read");
    expect(readTool.description).toContain("Reads a file from the local filesystem.");
    expect(readTool.description).toContain("file_path parameter must be an absolute path");
    expect(getSchemaKeys(readTool.schema)).toEqual(["file_path", "offset", "limit", "pages"]);

    const editTool = createFileEditTool();
    expect(editTool.name).toBe("Edit");
    expect(editTool.description).toContain("Performs exact string replacements in files.");
    expect(editTool.description).toContain("replace_all");
    expect(getSchemaKeys(editTool.schema)).toEqual([
      "file_path",
      "old_string",
      "new_string",
      "replace_all",
    ]);

    const writeTool = createFileWriteTool();
    expect(writeTool.name).toBe("Write");
    expect(writeTool.description).toContain("Writes a file to the local filesystem.");
    expect(writeTool.description).toContain("MUST use the Read tool first");
    expect(getSchemaKeys(writeTool.schema)).toEqual(["file_path", "content"]);

    const globTool = createGlobTool();
    expect(globTool.name).toBe("Glob");
    expect(globTool.description).toContain("Fast file pattern matching tool");
    expect(getSchemaKeys(globTool.schema)).toEqual(["pattern", "path"]);

    const grepTool = createGrepTool();
    expect(grepTool.name).toBe("Grep");
    expect(grepTool.description).toContain("A powerful search tool built on ripgrep");
    expect(getSchemaKeys(grepTool.schema)).toEqual([
      "pattern",
      "path",
      "glob",
      "type",
      "output_mode",
      "head_limit",
      "offset",
      "-i",
      "multiline",
      "-n",
      "-A",
      "-B",
      "-C",
    ]);
  });

  it("aligns execution and coordination tool contracts", () => {
    const bashTool = createBashTool();
    expect(bashTool.name).toBe("Bash");
    expect(bashTool.description).toContain("Executes a given bash command and returns its output.");
    expect(bashTool.description).toContain("IMPORTANT: Avoid using this tool");
    expect(bashTool.description).toContain("While the Bash tool can do similar things");
    expect(getSchemaKeys(bashTool.schema)).toEqual([
      "command",
      "timeout",
      "description",
      "run_in_background",
      "dangerouslyDisableSandbox",
    ]);

    const powerShellTool = createPowerShellTool();
    expect(powerShellTool.name).toBe("PowerShell");
    expect(powerShellTool.description).toContain(
      "Executes a given PowerShell command with optional timeout.",
    );
    expect(powerShellTool.description).toContain(
      "Before executing the command, please follow these steps:",
    );
    expect(powerShellTool.description).toContain(
      "Do NOT prefix commands with `cd` or `Set-Location`",
    );
    expect(getSchemaKeys(powerShellTool.schema)).toEqual([
      "command",
      "timeout",
      "description",
      "run_in_background",
      "dangerouslyDisableSandbox",
    ]);

    const agentTool = createAgentTool();
    expect(agentTool.name).toBe("Agent");
    expect(agentTool.description).toContain(
      "Launch a new agent to handle complex, multi-step tasks autonomously.",
    );
    expect(agentTool.description).toContain("## Writing the prompt");
    expect(agentTool.description).toContain(
      "To continue a previously spawned agent, use SendMessage",
    );
    expect(getSchemaKeys(agentTool.schema)).toEqual([
      "description",
      "prompt",
      "subagent_type",
      "model",
      "run_in_background",
      "name",
      "team_name",
      "mode",
      "isolation",
      "cwd",
    ]);

    const sendMessageTool = createSendMessageTool();
    expect(sendMessageTool.name).toBe("SendMessage");
    expect(sendMessageTool.description).toContain("# SendMessage");
    expect(sendMessageTool.description).toContain(
      "Your plain text output is NOT visible to other agents",
    );
    expect(getSchemaKeys(sendMessageTool.schema)).toEqual(["to", "summary", "message"]);

    const askUserQuestionTool = createAskUserQuestionTool();
    expect(askUserQuestionTool.name).toBe("AskUserQuestion");
    expect(askUserQuestionTool.description).toContain(
      "Use this tool when you need to ask the user questions during execution.",
    );
    expect(askUserQuestionTool.description).toContain(
      'Users will always be able to select "Other"',
    );
    expect(getSchemaKeys(askUserQuestionTool.schema)).toEqual([
      "questions",
      "answers",
      "annotations",
    ]);

    const briefTool = createBriefTool();
    expect(briefTool.name).toBe("SendUserMessage");
    expect(briefTool.description).toContain("Text outside this tool is visible in the detail view");
    expect(briefTool.description).toContain("`status` labels intent");
    expect(getSchemaKeys(briefTool.schema)).toEqual(["message", "attachments", "status"]);

    const todoTool = createTodoWriteTool();
    expect(todoTool.name).toBe("TodoWrite");
    expect(todoTool.description).toContain(
      "Use this tool to create and manage a structured task list",
    );
    expect(todoTool.description).toContain("## When to Use This Tool");

    const cronCreate = createScheduleCronCreateTool();
    expect(cronCreate.name).toBe("CronCreate");
    expect(cronCreate.description).toContain(
      "Uses standard 5-field cron in the user's local timezone",
    );
    expect(getSchemaKeys(cronCreate.schema)).toEqual(["cron", "prompt", "recurring", "durable"]);

    const cronList = createScheduleCronListTool();
    expect(cronList.name).toBe("CronList");
    expect(cronList.description).toContain("List all cron jobs scheduled via CronCreate");

    const cronDelete = createScheduleCronDeleteTool();
    expect(cronDelete.name).toBe("CronDelete");
    expect(cronDelete.description).toContain(
      "Cancel a cron job previously scheduled with CronCreate",
    );

    const configTool = createConfigTool();
    expect(configTool.name).toBe("config");
    expect(configTool.description).toContain("Get or set Claude Code configuration settings.");
    expect(configTool.description).toContain("## Usage");
    expect(configTool.description).toContain("## Configurable settings list");
    expect(getSchemaKeys(configTool.schema)).toEqual(["setting", "value"]);

    const toolSearch = createToolSearchTool();
    expect(toolSearch.name).toBe("ToolSearch");
    expect(toolSearch.description).toContain(
      "Fetches full schema definitions for deferred tools so they can be called.",
    );
    expect(toolSearch.description).toContain("Query forms:");
    expect(getSchemaKeys(toolSearch.schema)).toEqual(["query", "max_results"]);
  });

  it("aligns remaining Claude-style prompt descriptions and schema contracts", () => {
    const lspTool = createLspTool();
    expect(lspTool.name).toBe("LSP");
    expect(lspTool.description).toContain("Interact with Language Server Protocol (LSP) servers");
    expect(lspTool.description).toContain("Supported operations:");
    expect(getSchemaKeys(lspTool.schema)).toEqual(["operation", "filePath", "line", "character"]);

    const webFetchTool = createWebFetchTool();
    expect(webFetchTool.name).toBe("WebFetch");
    expect(webFetchTool.description).toContain(
      "Fetches content from a specified URL and processes it using an AI model",
    );
    expect(webFetchTool.description).toContain("If an MCP-provided web fetch tool is available");
    expect(getSchemaKeys(webFetchTool.schema)).toEqual(["url", "prompt"]);

    const webSearchTool = createWebSearchTool();
    expect(webSearchTool.name).toBe("WebSearch");
    expect(webSearchTool.description).toContain(
      "Allows Claude to search the web and use the results to inform responses",
    );
    expect(webSearchTool.description).toContain("CRITICAL REQUIREMENT - You MUST follow this:");
    expect(getSchemaKeys(webSearchTool.schema)).toEqual([
      "query",
      "allowed_domains",
      "blocked_domains",
    ]);

    const listMcpResourcesTool = createListMcpResourcesTool();
    expect(listMcpResourcesTool.name).toBe("ListMcpResources");
    expect(listMcpResourcesTool.description).toContain(
      "List available resources from configured MCP servers.",
    );
    expect(listMcpResourcesTool.description).toContain("server (optional)");
    expect(getSchemaKeys(listMcpResourcesTool.schema)).toEqual(["server"]);

    const readMcpResourceTool = createReadMcpResourceTool();
    expect(readMcpResourceTool.name).toBe("ReadMcpResource");
    expect(readMcpResourceTool.description).toContain(
      "Reads a specific resource from an MCP server",
    );
    expect(readMcpResourceTool.description).toContain("uri (required)");
    expect(getSchemaKeys(readMcpResourceTool.schema)).toEqual(["server", "uri"]);

    const mcpAuthTool = createMcpAuthTool();
    expect(mcpAuthTool.name).toBe("McpAuth");
    expect(mcpAuthTool.description).toContain("requires authentication");
    expect(mcpAuthTool.description).toContain("authorization URL");
    expect(getSchemaKeys(mcpAuthTool.schema)).toEqual(["server"]);

    const mcpTool = createMcpTool();
    expect(mcpTool.name).toBe("MCP");
    expect(mcpTool.description).toContain("Call a generic MCP tool");
    expect(mcpTool.description).toContain("server and tool name");
    expect(getSchemaKeys(mcpTool.schema)).toEqual(["server", "tool", "arguments"]);

    const remoteTriggerTool = createRemoteTriggerTool();
    expect(remoteTriggerTool.name).toBe("RemoteTrigger");
    expect(remoteTriggerTool.description).toContain("Call the claude.ai remote-trigger API");
    expect(remoteTriggerTool.description).toContain("Use this instead of curl");
    expect(getSchemaKeys(remoteTriggerTool.schema)).toEqual(["action", "trigger_id", "body"]);

    const skillTool = createSkillTool();
    expect(skillTool.name).toBe("Skill");
    expect(skillTool.description).toContain("Execute a skill within the main conversation");
    expect(skillTool.description).toContain("this is a BLOCKING REQUIREMENT");
    expect(getSchemaKeys(skillTool.schema)).toEqual(["skill", "args"]);

    const enterPlanModeTool = createEnterPlanModeTool();
    expect(enterPlanModeTool.name).toBe("EnterPlanMode");
    expect(enterPlanModeTool.description).toContain(
      "Use this tool proactively when you're about to start a non-trivial implementation task",
    );
    expect(enterPlanModeTool.description).toContain("## When to Use This Tool");
    expect(getSchemaKeys(enterPlanModeTool.schema)).toEqual([]);

    const exitPlanModeTool = createExitPlanModeTool();
    expect(exitPlanModeTool.name).toBe("ExitPlanMode");
    expect(exitPlanModeTool.description).toContain(
      "Use this tool when you are in plan mode and have finished writing your plan",
    );
    expect(exitPlanModeTool.description).toContain("Do NOT use AskUserQuestion to ask");
    expect(getSchemaKeys(exitPlanModeTool.schema)).toEqual(["allowedPrompts"]);

    const taskCreateTool = createTaskCreateTool();
    expect(taskCreateTool.name).toBe("TaskCreate");
    expect(taskCreateTool.description).toContain(
      "Use this tool to create a structured task list for your current coding session.",
    );
    expect(taskCreateTool.description).toContain("## Task Fields");
    expect(getSchemaKeys(taskCreateTool.schema)).toEqual([
      "subject",
      "description",
      "activeForm",
      "metadata",
    ]);

    const taskUpdateTool = createTaskUpdateTool();
    expect(taskUpdateTool.name).toBe("TaskUpdate");
    expect(taskUpdateTool.description).toContain(
      "Use this tool to update a task in the task list.",
    );
    expect(taskUpdateTool.description).toContain("## Status Workflow");
    expect(getSchemaKeys(taskUpdateTool.schema)).toEqual([
      "taskId",
      "subject",
      "description",
      "activeForm",
      "status",
      "owner",
      "metadata",
      "addBlocks",
      "addBlockedBy",
    ]);

    const taskGetTool = createTaskGetTool();
    expect(taskGetTool.name).toBe("TaskGet");
    expect(taskGetTool.description).toContain(
      "Use this tool to retrieve a task by its ID from the task list.",
    );
    expect(taskGetTool.description).toContain("Returns full task details");
    expect(getSchemaKeys(taskGetTool.schema)).toEqual(["taskId"]);

    const taskListTool = createTaskListTool();
    expect(taskListTool.name).toBe("TaskList");
    expect(taskListTool.description).toContain("Use this tool to list all tasks in the task list.");
    expect(taskListTool.description).toContain("Prefer working on tasks in ID order");
    expect(getSchemaKeys(taskListTool.schema)).toEqual([]);

    const taskStopTool = createTaskStopTool();
    expect(taskStopTool.name).toBe("TaskStop");
    expect(taskStopTool.description).toContain("Stops a running background task by its ID");
    expect(taskStopTool.description).toContain("task_id");
    expect(getSchemaKeys(taskStopTool.schema)).toEqual(["task_id"]);

    const taskOutputTool = createTaskOutputTool();
    expect(taskOutputTool.name).toBe("TaskOutput");
    expect(taskOutputTool.description).toContain("read output/logs from a background task");
    expect(taskOutputTool.description).toContain("Use block=true");
    expect(getSchemaKeys(taskOutputTool.schema)).toEqual(["task_id", "block", "timeout"]);

    const teamCreateTool = createTeamCreateTool();
    expect(teamCreateTool.name).toBe("TeamCreate");
    expect(teamCreateTool.description).toContain("# TeamCreate");
    expect(teamCreateTool.description).toContain("Automatic Message Delivery");
    expect(getSchemaKeys(teamCreateTool.schema)).toEqual([
      "team_name",
      "description",
      "agent_type",
    ]);

    const teamDeleteTool = createTeamDeleteTool();
    expect(teamDeleteTool.name).toBe("TeamDelete");
    expect(teamDeleteTool.description).toContain("# TeamDelete");
    expect(teamDeleteTool.description).toContain(
      "TeamDelete will fail if the team still has active members",
    );
    expect(getSchemaKeys(teamDeleteTool.schema)).toEqual([]);

    const enterWorktreeTool = createEnterWorktreeTool();
    expect(enterWorktreeTool.name).toBe("EnterWorktree");
    expect(enterWorktreeTool.description).toContain(
      "Use this tool ONLY when the user explicitly asks to work in a worktree.",
    );
    expect(enterWorktreeTool.description).toContain(
      'Never use this tool unless the user explicitly mentions "worktree"',
    );
    expect(getSchemaKeys(enterWorktreeTool.schema)).toEqual(["name"]);

    const exitWorktreeTool = createExitWorktreeTool();
    expect(exitWorktreeTool.name).toBe("ExitWorktree");
    expect(exitWorktreeTool.description).toContain(
      "Exit a worktree session created by EnterWorktree",
    );
    expect(exitWorktreeTool.description).toContain('`action` (required): `"keep"` or `"remove"`');
    expect(getSchemaKeys(exitWorktreeTool.schema)).toEqual(["action", "discard_changes"]);

    const notebookEditTool = createNotebookEditTool();
    expect(notebookEditTool.name).toBe("NotebookEdit");
    expect(notebookEditTool.description).toContain(
      "Completely replaces the contents of a specific cell in a Jupyter notebook",
    );
    expect(notebookEditTool.description).toContain("edit_mode=insert");
    expect(getSchemaKeys(notebookEditTool.schema)).toEqual([
      "notebook_path",
      "cell_id",
      "new_source",
      "cell_type",
      "edit_mode",
    ]);

    const sleepTool = createSleepTool();
    expect(sleepTool.name).toBe("Sleep");
    expect(sleepTool.description).toContain("Wait for a specified duration");
    expect(sleepTool.description).toContain("Prefer this over `Bash(sleep ...)`");

    const replTool = createReplTool();
    expect(replTool.name).toBe("REPL");
    expect(replTool.description).toContain(
      "Use this tool when you want to batch multiple primitive tool operations",
    );
    expect(replTool.description).toContain("primitive tools");

    const syntheticOutputTool = createSyntheticOutputTool({
      type: "object",
      properties: {
        verdict: { type: "string" },
      },
      required: ["verdict"],
      additionalProperties: false,
    });
    expect("tool" in syntheticOutputTool).toBe(true);
    if ("tool" in syntheticOutputTool) {
      expect(syntheticOutputTool.tool.name).toBe("StructuredOutput");
      expect(syntheticOutputTool.tool.description).toContain(
        "Use this tool to return your final response in the requested structured format",
      );
      expect(syntheticOutputTool.tool.description).toContain("MUST call this tool exactly once");
    }

    const gitStatusTool = createGitStatusTool();
    expect(gitStatusTool.name).toBe("git_status");
    expect(gitStatusTool.description).toContain("Show git status for the current workspace");
    expect(gitStatusTool.description).toContain(
      "Use this when you need a quick repo dirtiness snapshot",
    );

    const runChecksTool = createRunChecksTool();
    expect(runChecksTool.name).toBe("run_checks");
    expect(runChecksTool.description).toContain(
      "Run repo-aware verification commands such as tests, lint, build, or typecheck",
    );
    expect(runChecksTool.description).toContain("Prefer preset-based verification");
  });
});
