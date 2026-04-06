import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentRunContext, ToolContext } from "@renx/agent";
import { LocalBackend, applyStatePatch } from "@renx/agent";
import type { ToolCall } from "@renx/model";

import {
  createAgentTool,
  createAskUserQuestionTool,
  createBriefTool,
  createConfigTool,
  createEnterPlanModeTool,
  createEnterWorktreeTool,
  createExitPlanModeTool,
  createExitWorktreeTool,
  createLspTool,
  createListMcpResourcesTool,
  createMcpAuthTool,
  createMcpTool,
  createNotebookEditTool,
  createPowerShellTool,
  createReadMcpResourceTool,
  createRemoteTriggerTool,
  createReplTool,
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
  createTodoWriteTool,
  createToolSearchTool,
  createWebFetchTool,
  createWebSearchTool,
} from "../src/index";

const PLATFORM_STATE_KEY = "__agentToolsPlatform";

const tempDirs: string[] = [];
let server: Server | undefined;
let baseUrl = "";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(async () => {
  server = createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf8" });
      res.end("<html><body><main>hello enterprise tools</main></body></html>");
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address && typeof address !== "string") {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server = undefined;
  baseUrl = "";
});

function createToolContext(
  workspaceRoot: string,
  metadata?: Record<string, unknown>,
  backend: ToolContext["backend"] = new LocalBackend(),
): ToolContext {
  const runContext: AgentRunContext = {
    input: {
      messages: [
        {
          id: "msg_platform_1",
          messageId: "msg_platform_1",
          role: "user",
          content: "test",
          createdAt: new Date().toISOString(),
          source: "input",
        },
      ],
    },
    identity: { userId: "u1", tenantId: "t1", roles: ["developer"] },
    state: {
      runId: "run_1",
      messages: [],
      scratchpad: {},
      memory: {},
      stepCount: 0,
      status: "running",
    },
    services: {},
    metadata: { workspaceRoot, ...(metadata ?? {}) },
  };
  const toolCall: ToolCall = { id: "tc_1", name: "tool", input: {} };
  return { runContext, toolCall, backend };
}

const applyResult = (ctx: ToolContext, result: { statePatch?: AgentRunContext["state"] | any }) => {
  ctx.runContext.state = applyStatePatch(ctx.runContext.state, result.statePatch);
};

describe("platform coordination tools", () => {
  it("tracks plan mode, worktree, config, todos, tasks, teams, and user-visible messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-platform-"));
    tempDirs.push(dir);
    const ctx = createToolContext(dir, {
      toolCatalog: [
        { name: "Read", description: "Read a file" },
        { name: "Grep", description: "Search files" },
      ],
      skillsCatalog: [
        { name: "typescript", description: "TS rules", path: "/skills/typescript.md" },
      ],
    });

    applyResult(ctx, await createEnterPlanModeTool().invoke({}, ctx));
    applyResult(ctx, await createEnterWorktreeTool().invoke({ name: "codex-tools" }, ctx));
    applyResult(ctx, await createConfigTool().invoke({ setting: "model", value: "sonnet" }, ctx));
    applyResult(
      ctx,
      await createTodoWriteTool().invoke(
        {
          todos: [
            { id: "todo-1", content: "write tests", status: "in_progress" },
            { id: "todo-2", content: "ship tools", status: "pending" },
          ],
        },
        ctx,
      ),
    );
    applyResult(
      ctx,
      await createTeamCreateTool().invoke({ team_name: "team-1", description: "Platform" }, ctx),
    );
    const createdTask = await createTaskCreateTool().invoke(
      { subject: "Build tools", description: "Implement SDK tools" },
      ctx,
    );
    applyResult(ctx, createdTask);
    const taskId = (createdTask.structured as { task: { id: string } }).task.id;
    applyResult(ctx, await createTaskUpdateTool().invoke({ taskId, status: "in_progress" }, ctx));
    applyResult(
      ctx,
      await createSendMessageTool().invoke(
        { to: "team:team-1", summary: "status", message: "Task started" },
        ctx,
      ),
    );

    const toolSearch = await createToolSearchTool().invoke({ query: "read" }, ctx);
    expect(toolSearch.structured).toMatchObject({
      matches: ["Read"],
    });

    const skillTool = await createSkillTool().invoke({ skill: "typescript" }, ctx);
    applyResult(ctx, skillTool);
    expect(skillTool.content).toContain("Launching skill: typescript");

    const userMessage = await createBriefTool().invoke(
      { message: "Here is the current status.", status: "normal" },
      ctx,
    );
    applyResult(ctx, userMessage);
    expect(userMessage.content).toContain("current status");

    const taskGet = await createTaskGetTool().invoke({ taskId }, ctx);
    expect(taskGet.content).toContain("Build tools");

    const taskList = await createTaskListTool().invoke({}, ctx);
    expect(taskList.content).toContain(taskId);

    applyResult(ctx, await createTaskUpdateTool().invoke({ taskId, status: "completed" }, ctx));
    applyResult(ctx, await createTeamDeleteTool().invoke({}, ctx));
    applyResult(ctx, await createExitWorktreeTool().invoke({ action: "keep" }, ctx));
    applyResult(ctx, await createExitPlanModeTool().invoke({}, ctx));

    expect(ctx.runContext.state.scratchpad).toMatchObject({
      __agentToolsPlatform: {
        planMode: { active: false },
        worktree: { active: false },
      },
    });
  });

  it("creates, lists, and deletes cron schedules plus records AskUserQuestion state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-schedule-"));
    tempDirs.push(dir);
    const ctx = createToolContext(dir);

    const created = await createScheduleCronCreateTool().invoke(
      { cron: "7 * * * *", prompt: "run checks", recurring: true, durable: false },
      ctx,
    );
    applyResult(ctx, created);
    expect(created.content).toContain("Created schedule");

    const listResult = await createScheduleCronListTool().invoke({}, ctx);
    expect(listResult.content).toContain("7 * * * *");

    const questionResult = await createAskUserQuestionTool().invoke(
      {
        questions: [
          {
            question: "Which library should we use?",
            header: "Library",
            options: [
              { label: "Zod (Recommended)", description: "Keep runtime validation." },
              { label: "Valibot", description: "Smaller runtime." },
            ],
          },
        ],
      },
      ctx,
    );
    applyResult(ctx, questionResult);
    expect(ctx.runContext.state.status).toBe("waiting_approval");

    const scheduleId = Object.keys(
      (
        ctx.runContext.state.scratchpad[PLATFORM_STATE_KEY] as {
          schedules?: Record<string, unknown>;
        }
      ).schedules ?? {},
    )[0];
    applyResult(ctx, await createScheduleCronDeleteTool().invoke({ id: scheduleId }, ctx));

    const listAfterDelete = await createScheduleCronListTool().invoke({}, ctx);
    expect(listAfterDelete.content).toContain("No scheduled");
  });

  it("spawns agents with Claude-style input and allows SendMessage continuations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-agent-"));
    tempDirs.push(dir);

    const calls: string[] = [];
    const ctx = createToolContext(dir, {
      agentRunnerProvider: {
        runSync: async (request: Record<string, unknown>) => ({
          request,
          status: "completed",
          output: { summary: "runner completed" },
          transcript: "agent finished work",
        }),
        sendMessage: async (agentId: string, request: { message: string }) => {
          calls.push(`${agentId}:${request.message}`);
          return {
            status: "running",
            transcript: "provider acknowledged message",
            sharedContext: { providerAck: true },
          };
        },
      },
    });

    const agentResult = await createAgentTool().invoke(
      {
        description: "Independent review",
        prompt: "Review the patch and summarize risks.",
        subagent_type: "code-reviewer",
        name: "review-agent",
      },
      ctx,
    );
    applyResult(ctx, agentResult);
    expect(agentResult.structured).toMatchObject({
      status: "completed",
      agent_id: "review-agent",
    });

    const messageResult = await createSendMessageTool().invoke(
      { to: "review-agent", summary: "follow up", message: "Check migrations too" },
      ctx,
    );
    applyResult(ctx, messageResult);
    expect(calls).toEqual(["review-agent:Check migrations too"]);
  });

  it("supports background agent runs and provider-managed launch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-agent-bg-"));
    tempDirs.push(dir);
    const outputFile = join(dir, "provider-agent.log");

    const ctx = createToolContext(dir, {
      agentRunnerProvider: {
        launchBackground: async () => {
          await writeFile(outputFile, "provider background output", "utf8");
          return {
            status: "running",
            taskId: "provider-task-1",
            outputFile,
          };
        },
      },
    });

    const result = await createAgentTool().invoke(
      {
        description: "Background verification",
        prompt: "Run a long verification pass.",
        subagent_type: "verification",
        run_in_background: true,
        isolation: "worktree",
      },
      ctx,
    );
    applyResult(ctx, result);

    expect(result.structured).toMatchObject({
      status: "async_launched",
      taskId: "provider-task-1",
      isolation: "worktree",
    });
    expect(await readFile(outputFile, "utf8")).toContain("provider background output");
  });

  it("polls provider-managed background agents by task_id until completion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-agent-bg-task-output-"));
    tempDirs.push(dir);
    const outputFile = join(dir, "provider-agent-final.log");
    let statusCalls = 0;

    const launchCtx = createToolContext(dir, {
      agentRunnerProvider: {
        launchBackground: async () => ({
          status: "running",
          taskId: "provider-task-1",
          outputFile,
        }),
        getStatus: async (agentId: string) => {
          expect(agentId).toBe("provider-agent");
          statusCalls += 1;
          if (statusCalls === 1) {
            return {
              status: "running",
              taskId: "provider-task-1",
              outputFile,
            };
          }
          await writeFile(outputFile, "provider background final answer", "utf8");
          return {
            status: "completed",
            taskId: "provider-task-1",
            outputFile,
            output: "provider background final answer",
            transcript: "provider background final answer",
          };
        },
      },
    });

    const launched = await createAgentTool().invoke(
      {
        description: "Background verification",
        prompt: "Run a long verification pass.",
        name: "provider-agent",
        run_in_background: true,
      },
      launchCtx,
    );

    const resumedCtx = {
      ...launchCtx,
      runContext: {
        ...launchCtx.runContext,
        state: applyStatePatch(launchCtx.runContext.state, launched.statePatch),
      },
    };

    const result = await createTaskOutputTool().invoke(
      { task_id: "provider-task-1", block: true, timeout: 250 },
      resumedCtx,
    );

    expect(statusCalls).toBeGreaterThan(0);
    expect(result.structured).toMatchObject({
      retrieval_status: "success",
      task: {
        task_id: "provider-task-1",
        task_type: "local_agent",
        status: "completed",
        output: "provider background final answer",
        result: "provider background final answer",
      },
    });
  });

  it("reads completed background shell output with Claude-style TaskOutput semantics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-task-output-shell-"));
    tempDirs.push(dir);
    const outputFile = join(dir, "shell-task.log");
    await writeFile(outputFile, "shell stdout\n\nexit_code: 0", "utf8");

    const ctx = createToolContext(dir);
    ctx.runContext.state.scratchpad[PLATFORM_STATE_KEY] = {
      shellCommands: {
        shell_1: {
          id: "shell_1",
          command: "Write-Output shell stdout",
          cwd: dir,
          status: "completed",
          readOnly: true,
          outputFile,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          description: "Background shell verification",
          exitCode: 0,
        },
      },
    };

    const result = await createTaskOutputTool().invoke({ task_id: "shell_1", block: false }, ctx);
    expect(result.structured).toMatchObject({
      retrieval_status: "success",
      task: {
        task_id: "shell_1",
        task_type: "local_bash",
        status: "completed",
        description: "Background shell verification",
        output: "shell stdout\n\nexit_code: 0",
        exitCode: 0,
      },
    });
  });

  it("returns not_ready for a running task without blocking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-task-output-running-"));
    tempDirs.push(dir);
    const outputFile = join(dir, "running-shell.log");
    await writeFile(outputFile, "partial shell output", "utf8");

    const ctx = createToolContext(dir);
    ctx.runContext.state.scratchpad[PLATFORM_STATE_KEY] = {
      shellCommands: {
        shell_2: {
          id: "shell_2",
          command: "Write-Output partial",
          cwd: dir,
          status: "running",
          readOnly: true,
          outputFile,
          startedAt: new Date().toISOString(),
        },
      },
    };

    const result = await createTaskOutputTool().invoke({ task_id: "shell_2", block: false }, ctx);
    expect(result.structured).toMatchObject({
      retrieval_status: "not_ready",
      task: {
        task_id: "shell_2",
        task_type: "local_bash",
        status: "running",
        output: "partial shell output",
      },
    });
  });

  it("waits for a background agent to finish and returns its output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-task-output-agent-"));
    tempDirs.push(dir);
    const outputFile = join(dir, "agent-task.log");
    await writeFile(outputFile, "background agent final answer", "utf8");

    const ctx = createToolContext(dir);
    const scratchpadState = {
      agents: {
        agent_1: {
          id: "agent_1",
          role: "verification",
          objective: "Review the patch and summarize the result.",
          status: "running",
          outputFile,
          runInBackground: true,
          messages: [],
          sharedContext: {
            description: "Background verification",
          },
          updatedAt: new Date().toISOString(),
        },
      },
    };
    ctx.runContext.state.scratchpad[PLATFORM_STATE_KEY] = scratchpadState;

    setTimeout(() => {
      (scratchpadState.agents as Record<string, { status: string }>).agent_1!.status = "completed";
    }, 25);

    const result = await createTaskOutputTool().invoke(
      { task_id: "agent_1", block: true, timeout: 250 },
      ctx,
    );
    expect(result.structured).toMatchObject({
      retrieval_status: "success",
      task: {
        task_id: "agent_1",
        task_type: "local_agent",
        status: "completed",
        description: "Background verification",
        prompt: "Review the patch and summarize the result.",
        result: "background agent final answer",
        output: "background agent final answer",
      },
    });
  });
});

describe("web, mcp, and utility tools", () => {
  it("fetches pages, uses injected web search, and proxies MCP resources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-web-"));
    tempDirs.push(dir);
    const ctx = createToolContext(dir, {
      webSearchProvider: async (query: { query: string }) => [
        {
          title: `Result for ${query.query}`,
          url: `${baseUrl}/page`,
          snippet: "hello enterprise tools",
        },
      ],
      mcpProvider: {
        listResources: async (server?: string) => [
          {
            id: "res-1",
            name: "Readme",
            uri: "memory://readme",
            mimeType: "text/plain",
            server: server ?? "demo",
          },
        ],
        readResource: async (server: string, uri: string) => ({
          id: "res-1",
          name: "Readme",
          uri,
          mimeType: "text/plain",
          content: "resource body",
          server,
        }),
        authenticate: async (server: string) => ({
          status: "authenticated" as const,
          message: `MCP server ${server} authenticated.`,
        }),
        callTool: async (server: string, name: string, input: unknown) => ({
          server,
          name,
          output: { echoed: input },
        }),
      },
    });

    expect(
      (
        await createWebFetchTool().invoke(
          { url: `${baseUrl}/page`, prompt: "Extract the page body" },
          ctx,
        )
      ).content,
    ).toContain("hello enterprise tools");
    expect(
      (await createWebSearchTool().invoke({ query: "enterprise tools" }, ctx)).content,
    ).toContain("Result for enterprise tools");
    expect((await createListMcpResourcesTool().invoke({}, ctx)).content).toContain("res-1");
    expect(
      (await createReadMcpResourceTool().invoke({ server: "demo", uri: "memory://readme" }, ctx))
        .content,
    ).toContain("resource body");
    expect((await createMcpAuthTool().invoke({ server: "demo" }, ctx)).content).toContain(
      "authenticated",
    );
    expect(
      (await createMcpTool().invoke({ server: "demo", tool: "echo", arguments: { value: 1 } }, ctx))
        .content,
    ).toContain("echoed");
  });

  it("invokes remote triggers and lsp providers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-provider-"));
    tempDirs.push(dir);
    const ctx = createToolContext(dir, {
      remoteTriggerProvider: async (request: { action: string; body?: unknown }) => ({
        action: request.action,
        body: request.body,
        accepted: true,
      }),
      lspProvider: {
        run: async (action: string, input: unknown) => ({
          action,
          input,
          results: [{ name: "demoSymbol", kind: "function", path: "src/demo.ts", line: 3 }],
        }),
      },
    });

    expect(
      (
        await createRemoteTriggerTool().invoke(
          { action: "create", body: { event: "deploy.started", env: "staging" } },
          ctx,
        )
      ).content,
    ).toContain("deploy.started");
    expect(
      (
        await createLspTool().invoke(
          { operation: "documentSymbol", filePath: "src/demo.ts", line: 3, character: 1 },
          ctx,
        )
      ).content,
    ).toContain("demoSymbol");
  });

  it("edits notebooks, runs PowerShell, sleeps, evaluates expressions, and returns synthetic output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-utility-"));
    tempDirs.push(dir);
    const notebookPath = join(dir, "demo.ipynb");

    await mkdir(dir, { recursive: true });
    await writeFile(
      notebookPath,
      JSON.stringify(
        {
          cells: [
            {
              cell_type: "code",
              metadata: {},
              source: ["print('hello')\n"],
              outputs: [],
              execution_count: null,
            },
          ],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        },
        null,
        2,
      ),
      "utf8",
    );

    const ctx = createToolContext(dir);

    applyResult(
      ctx,
      await createNotebookEditTool().invoke(
        {
          notebook_path: "demo.ipynb",
          cell_id: "0",
          new_source: "print('world')\n",
          edit_mode: "replace",
        },
        ctx,
      ),
    );
    expect(await readFile(notebookPath, "utf8")).toContain("world");

    expect(
      (
        await createPowerShellTool().invoke({ command: "Write-Output agent-tools" }, ctx)
      ).content.toLowerCase(),
    ).toContain("agent-tools");

    const before = Date.now();
    await createSleepTool().invoke({ durationMs: 20 }, ctx);
    expect(Date.now() - before).toBeGreaterThanOrEqual(15);

    expect(
      (await createReplTool().invoke({ language: "javascript", code: "return 1 + 2 + 3;" }, ctx))
        .content,
    ).toContain("6");
    const structuredOutput = createSyntheticOutputTool({
      type: "object",
      properties: {
        content: { type: "string" },
        metadata: {
          type: "object",
          additionalProperties: true,
        },
      },
      required: ["content"],
      additionalProperties: false,
    });
    if ("error" in structuredOutput) {
      throw new Error(structuredOutput.error);
    }
    expect(
      (
        await structuredOutput.tool.invoke(
          { content: "synthetic complete", metadata: { ok: true } },
          ctx,
        )
      ).content,
    ).toContain("Structured output provided successfully");
  });

  it("classifies read-only PowerShell commands, supports background runs, and enforces policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-powershell-"));
    tempDirs.push(dir);

    const observed: Array<{ command: string; cwd?: string }> = [];
    const backend: ToolContext["backend"] = {
      kind: "fake",
      capabilities: () => ({
        exec: true,
        filesystemRead: true,
        filesystemWrite: true,
        network: false,
      }),
      exec: async (command, opts) => {
        observed.push({
          command,
          ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        });
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    };
    const ctx = createToolContext(
      dir,
      {
        powershellPolicy: {
          denyPatterns: ["Remove-Item"],
        },
      },
      backend,
    );
    const tool = createPowerShellTool();

    expect(tool.isReadOnly?.({ command: "Get-Content .\\demo.txt" })).toBe(true);
    expect(tool.isReadOnly?.({ command: "Set-Content .\\demo.txt value" })).toBe(false);

    const result = await tool.invoke({ command: "Write-Output hi" }, ctx);
    expect(result.content).toContain("exit_code: 0");
    expect(observed).toEqual([{ command: "Write-Output hi", cwd: dir }]);

    await expect(tool.invoke({ command: "Start-Sleep 5" }, ctx)).rejects.toThrow(
      /background|sleep/i,
    );
    await expect(tool.invoke({ command: "Remove-Item .\\temp.txt -Force" }, ctx)).rejects.toThrow(
      /policy/i,
    );

    const background = await tool.invoke(
      {
        command: "Write-Output background",
        description: "run in background",
        run_in_background: true,
      },
      ctx,
    );
    applyResult(ctx, background);
    expect(background.structured).toMatchObject({
      status: "async_launched",
      description: "run in background",
    });
  });

  it("tracks background PowerShell completion across immutable run-context replacements", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-tools-powershell-bg-runtime-"));
    tempDirs.push(dir);

    const backend: ToolContext["backend"] = {
      kind: "fake",
      capabilities: () => ({
        exec: true,
        filesystemRead: true,
        filesystemWrite: true,
        network: false,
      }),
      exec: async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        });
        return {
          stdout: "background powershell output",
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const launchCtx = createToolContext(dir, undefined, backend);
    const launched = await createPowerShellTool().invoke(
      {
        command: "Write-Output background",
        description: "background test",
        run_in_background: true,
      },
      launchCtx,
    );
    const taskId = (launched.structured as { taskId: string }).taskId;

    const resumedCtx = {
      ...launchCtx,
      runContext: {
        ...launchCtx.runContext,
        state: applyStatePatch(launchCtx.runContext.state, launched.statePatch),
      },
    };

    const result = await createTaskOutputTool().invoke(
      { task_id: taskId, block: true, timeout: 250 },
      resumedCtx,
    );

    expect(result.structured).toMatchObject({
      retrieval_status: "success",
      task: {
        task_id: taskId,
        task_type: "local_bash",
        status: "completed",
        output: expect.stringContaining("background powershell output"),
        exitCode: 0,
      },
    });
  });
});
