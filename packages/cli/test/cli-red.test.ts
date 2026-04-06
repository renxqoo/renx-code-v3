import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";

import type { AgentResult, AgentStreamEvent, AgentTool, DeepAgentHandle } from "@renx/agent";
import type { ModelClient, ModelProvider, ResolvedModel } from "@renx/model";

import { parseCliArgs, resolveProviderSetup, runCodingAgentCli, type CliEnvironment } from "../src";

const createFakeModelClient = (): ModelClient => ({
  generate: async () => ({ type: "final", output: "ok" }),
  stream: async function* () {
    yield { type: "done" as const };
  },
  resolve: (model): ResolvedModel => ({
    logicalModel: model,
    provider: "openai",
    providerModel: model,
  }),
});

describe("coding cli", () => {
  it("does not map runtime workspace packages to declaration files in cli tsconfig", () => {
    const raw = readFileSync("D:\\work\\renx-code-v3\\packages\\cli\\tsconfig.json", "utf8");
    const parsed = JSON.parse(raw) as {
      compilerOptions?: {
        paths?: Record<string, string[]>;
      };
    };

    const mapped = parsed.compilerOptions?.paths?.["@renx/agent"] ?? [];
    expect(mapped.every((entry) => !entry.endsWith(".d.ts"))).toBe(true);
  });

  it("parses prompt, workspace, and model options from argv", () => {
    const parsed = parseCliArgs(["--model", "gpt-5.4", "--cwd", "D:\\repo", "fix", "the", "bug"]);

    expect(parsed).toMatchObject({
      command: "run",
      model: "gpt-5.4",
      cwd: "D:\\repo",
      prompt: "fix the bug",
    });
  });

  it("parses a persistent storage directory for timeline state", () => {
    const parsed = parseCliArgs(["--storage-dir", "D:\\state", "continue", "working"], "D:\\repo");

    expect(parsed).toMatchObject({
      command: "run",
      storageDir: "D:\\state",
      prompt: "continue working",
    });
  });

  it("defaults storage directory to the current system home directory", () => {
    const parsed = parseCliArgs(["continue", "working"], "D:\\repo");

    expect(parsed).toMatchObject({
      command: "run",
      storageDir: expect.stringMatching(
        new RegExp(`^${homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      ),
      prompt: "continue working",
    });
  });

  it("defaults skills scanning to the storage-dir skills directory", () => {
    const parsed = parseCliArgs(["--storage-dir", "D:\\state", "continue", "working"], "D:\\repo");

    expect(parsed).toMatchObject({
      command: "run",
      storageDir: "D:\\state",
      skills: ["D:\\state\\skills"],
    });
  });

  it("merges explicit skill directories with the default storage-dir skills directory", () => {
    const parsed = parseCliArgs(
      ["--storage-dir", "D:\\state", "--skill", "D:\\extra-skills", "continue"],
      "D:\\repo",
    );

    expect(parsed).toMatchObject({
      command: "run",
      skills: ["D:\\state\\skills", "D:\\extra-skills"],
    });
  });

  it("resolves all configured providers from environment when no explicit provider is requested", () => {
    const createdProviders: string[] = [];
    const setup = resolveProviderSetup(
      {
        command: "run",
        model: "gpt-5.4",
        cwd: process.cwd(),
        prompt: "ship it",
        memory: [],
        skills: [],
      },
      {
        OPENAI_API_KEY: "sk-openai",
        OPENROUTER_API_KEY: "sk-openrouter",
      },
      {
        createOpenAIProvider: (input) => {
          createdProviders.push(`openai:${input.apiKey}`);
          return { name: "openai" } as ModelProvider;
        },
        createOpenRouterProvider: (input) => {
          createdProviders.push(`openrouter:${input.apiKey}`);
          return { name: "openrouter" } as ModelProvider;
        },
      },
    );

    expect(setup.providers.map((provider) => provider.name)).toEqual(["openai", "openrouter"]);
    expect(createdProviders).toEqual(["openai:sk-openai", "openrouter:sk-openrouter"]);
  });

  it("runs the coding agent with workspace metadata and prints the final output", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const createdTools: AgentTool[] = [{ name: "Read", description: "", invoke: vi.fn() as never }];
    let capturedOptions: Record<string, unknown> | undefined;
    let capturedInput: Record<string, unknown> | undefined;

    const exitCode = await runCodingAgentCli(
      [
        "--model",
        "gpt-5.4",
        "--cwd",
        "D:\\repo",
        "--storage-dir",
        "D:\\state",
        "inspect",
        "and",
        "fix",
      ],
      {
        cwd: () => "D:\\current",
        env: {
          OPENAI_API_KEY: "sk-test",
        },
        stdout: {
          write: (chunk: string) => {
            stdout.push(chunk);
            return true;
          },
        },
        stderr: {
          write: (chunk: string) => {
            stderr.push(chunk);
            return true;
          },
        },
        createCodingToolset: () => createdTools,
        createProviderSetup: () => ({
          providers: [{ name: "openai" } as ModelProvider],
          binding: {
            client: createFakeModelClient(),
            name: "gpt-5.4",
          },
        }),
        createCodingAgent: (options): DeepAgentHandle => {
          capturedOptions = options as Record<string, unknown>;
          return {
            invoke: async (input): Promise<AgentResult> => {
              capturedInput = input as Record<string, unknown>;
              return {
                runId: "run_1",
                status: "completed",
                output: "patched successfully",
                state: {
                  runId: "run_1",
                  messages: [],
                  scratchpad: {},
                  memory: {},
                  stepCount: 1,
                  status: "completed",
                },
              };
            },
            stream: async function* (input) {
              capturedInput = input as Record<string, unknown>;
              return {
                runId: "run_1",
                status: "completed",
                output: "patched successfully",
                state: {
                  runId: "run_1",
                  messages: [],
                  scratchpad: {},
                  memory: {},
                  stepCount: 1,
                  status: "completed",
                },
              };
            },
            resume: vi.fn() as never,
            resumeAt: vi.fn() as never,
            compact: vi.fn() as never,
            extractSessionMemory: vi.fn() as never,
            loadResumeSnapshot: vi.fn() as never,
            loadResumeSnapshotAt: vi.fn() as never,
            loadMemorySnapshot: vi.fn() as never,
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(capturedOptions).toMatchObject({
      model: {
        name: "gpt-5.4",
      },
      tools: createdTools,
    });
    expect(capturedOptions?.timeline).toBeDefined();
    expect(capturedInput).toMatchObject({
      metadata: {
        workspaceRoot: "D:\\repo",
      },
    });
    expect(stdout.join("")).toContain("patched successfully");
    expect(stderr.join("")).toBe("");
  });

  it("streams assistant output and tool progress while the run is executing", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const writes: string[] = [];
    let invokeCalled = false;
    let capturedInput: Record<string, unknown> | undefined;

    const streamEvents: AgentStreamEvent[] = [
      { type: "run_started", runId: "run_stream" },
      { type: "model_started" },
      { type: "assistant_delta", text: "Analyzing" },
      { type: "assistant_delta", text: " workspace" },
      {
        type: "tool_call",
        call: {
          id: "call_1",
          name: "Read",
          input: {
            path: "src/app.ts",
          },
        },
      },
      {
        type: "tool_result",
        result: {
          content: "loaded src/app.ts",
        },
      },
      { type: "assistant_delta", text: "done" },
      { type: "run_completed", output: "Analyzing workspace done" },
    ];

    const exitCode = await runCodingAgentCli(["inspect", "stream"], {
      cwd: () => "D:\\repo",
      env: {
        OPENAI_API_KEY: "sk-test",
      },
      stdout: {
        write: (chunk: string) => {
          stdout.push(chunk);
          writes.push(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr.push(chunk);
          return true;
        },
      },
      createProviderSetup: () => ({
        providers: [{ name: "openai" } as ModelProvider],
        binding: {
          client: createFakeModelClient(),
          name: "gpt-5.4",
        },
      }),
      createCodingToolset: () => [],
      createCodingAgent: (): DeepAgentHandle => ({
        invoke: async (): Promise<AgentResult> => {
          invokeCalled = true;
          return {
            runId: "run_stream",
            status: "completed",
            output: "invoke should not be used",
            state: {
              runId: "run_stream",
              messages: [],
              scratchpad: {},
              memory: {},
              stepCount: 1,
              status: "completed",
            },
          };
        },
        stream: async function* (input) {
          capturedInput = input as Record<string, unknown>;
          for (const event of streamEvents) {
            yield event;
          }
          return {
            runId: "run_stream",
            status: "completed",
            output: "Analyzing workspace done",
            state: {
              runId: "run_stream",
              messages: [],
              scratchpad: {},
              memory: {},
              stepCount: 1,
              status: "completed",
            },
          };
        },
        resume: vi.fn() as never,
        resumeAt: vi.fn() as never,
        compact: vi.fn() as never,
        extractSessionMemory: vi.fn() as never,
        loadResumeSnapshot: vi.fn() as never,
        loadResumeSnapshotAt: vi.fn() as never,
        loadMemorySnapshot: vi.fn() as never,
      }),
    });

    expect(exitCode).toBe(0);
    expect(invokeCalled).toBe(false);
    expect(capturedInput).toMatchObject({
      metadata: {
        workspaceRoot: "D:\\repo",
      },
    });
    expect(writes).toEqual([
      "Analyzing",
      " workspace",
      "\n",
      '[tool] Read {"path":"src/app.ts"}\n',
      "[tool-result] loaded src/app.ts\n",
      "done",
      "\n",
    ]);
    expect(stdout.join("")).toContain("Analyzing workspace");
    expect(stdout.join("")).toContain('[tool] Read {"path":"src/app.ts"}');
    expect(stdout.join("")).toContain("[tool-result] loaded src/app.ts");
    expect(stderr.join("")).toBe("");
  });

  it("fails fast with a clear message when no prompt is provided", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCodingAgentCli([], {
      cwd: () => "D:\\repo",
      env: {
        OPENAI_API_KEY: "sk-test",
      },
      stdout: {
        write: (chunk: string) => {
          stdout.push(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr.push(chunk);
          return true;
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout.join("")).toBe("");
    expect(stderr.join("")).toContain("Prompt is required");
  });
});
