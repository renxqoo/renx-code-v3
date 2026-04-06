import { resolve } from "node:path";

import { FileTimelineStore } from "@renx/agent";
import type { AgentResult, AgentStreamEvent } from "@renx/agent";
import { createCodingToolset } from "@renx/agent-tools";
import { createCodingAgent } from "@renx/coding-agent";

import { parseCliArgs, renderCliHelp } from "./args";
import { resolveProviderSetup } from "./providers";
import type { CliRuntimeDeps } from "./types";

const writeLine = (writer: { write(chunk: string): boolean }, text: string): void => {
  writer.write(text.endsWith("\n") ? text : `${text}\n`);
};

const writeChunk = (writer: { write(chunk: string): boolean }, text: string): boolean =>
  writer.write(text);

interface StreamRenderState {
  endedWithNewline: boolean;
  sawAssistantDelta: boolean;
  sawRunCompleted: boolean;
  sawRunFailed: boolean;
}

const createStreamRenderState = (): StreamRenderState => ({
  endedWithNewline: true,
  sawAssistantDelta: false,
  sawRunCompleted: false,
  sawRunFailed: false,
});

const markWrite = (state: StreamRenderState, chunk: string): void => {
  state.endedWithNewline = chunk.endsWith("\n");
};

const writeStreamChunk = (
  writer: { write(chunk: string): boolean },
  state: StreamRenderState,
  chunk: string,
): void => {
  writeChunk(writer, chunk);
  markWrite(state, chunk);
};

const writeStreamLine = (
  writer: { write(chunk: string): boolean },
  state: StreamRenderState,
  text: string,
): void => {
  const chunk = text.endsWith("\n") ? text : `${text}\n`;
  writeChunk(writer, chunk);
  markWrite(state, chunk);
};

const ensureTrailingNewline = (
  writer: { write(chunk: string): boolean },
  state: StreamRenderState,
): void => {
  if (state.endedWithNewline) return;
  writeStreamChunk(writer, state, "\n");
};

const formatToolInput = (input: unknown): string => {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
};

const renderStreamEvent = (
  event: AgentStreamEvent,
  runtime: Pick<CliRuntimeDeps, "stdout" | "stderr">,
  state: StreamRenderState,
): void => {
  switch (event.type) {
    case "assistant_delta":
      state.sawAssistantDelta = true;
      writeStreamChunk(runtime.stdout, state, event.text);
      return;
    case "tool_call":
      ensureTrailingNewline(runtime.stdout, state);
      writeStreamLine(
        runtime.stdout,
        state,
        `[tool] ${event.call.name} ${formatToolInput(event.call.input)}`,
      );
      return;
    case "tool_result":
      ensureTrailingNewline(runtime.stdout, state);
      writeStreamLine(runtime.stdout, state, `[tool-result] ${event.result.content}`);
      return;
    case "run_completed":
      state.sawRunCompleted = true;
      if (!state.sawAssistantDelta && event.output.length > 0) {
        writeStreamLine(runtime.stdout, state, event.output);
        return;
      }
      ensureTrailingNewline(runtime.stdout, state);
      return;
    case "run_failed":
      state.sawRunFailed = true;
      ensureTrailingNewline(runtime.stdout, state);
      writeLine(runtime.stderr, event.error.message ?? "Agent run failed.");
      return;
    case "run_started":
    case "model_started":
    case "tool_call_delta":
      return;
  }
};

const finalizeStreamOutput = (
  result: AgentResult,
  runtime: Pick<CliRuntimeDeps, "stdout" | "stderr">,
  state: StreamRenderState,
): number => {
  if (result.status === "failed") {
    if (!state.sawRunFailed) {
      ensureTrailingNewline(runtime.stdout, state);
      writeLine(runtime.stderr, result.error?.message ?? "Agent run failed.");
    }
    return 1;
  }

  if (!state.sawRunCompleted) {
    if (!state.sawAssistantDelta && result.output) {
      writeStreamLine(runtime.stdout, state, result.output);
    } else {
      ensureTrailingNewline(runtime.stdout, state);
    }
  }

  return 0;
};

export const runCodingAgentCli = async (
  argv: string[],
  deps?: Partial<CliRuntimeDeps>,
): Promise<number> => {
  const runtime: CliRuntimeDeps = {
    cwd: deps?.cwd ?? (() => process.cwd()),
    env: deps?.env ?? process.env,
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    ...(deps?.createProviderSetup ? { createProviderSetup: deps.createProviderSetup } : {}),
    ...(deps?.createCodingToolset ? { createCodingToolset: deps.createCodingToolset } : {}),
    ...(deps?.createCodingAgent ? { createCodingAgent: deps.createCodingAgent } : {}),
  };

  try {
    const parsed = parseCliArgs(argv, runtime.cwd());
    if (parsed.command === "help") {
      writeLine(runtime.stdout, renderCliHelp());
      return 0;
    }
    if (parsed.prompt.length === 0) {
      writeLine(
        runtime.stderr,
        "Prompt is required. Pass a task after the options, or use --help.",
      );
      return 1;
    }

    const workspaceRoot = resolve(parsed.cwd);
    const providerSetup = runtime.createProviderSetup
      ? runtime.createProviderSetup(parsed, runtime.env)
      : resolveProviderSetup(parsed, runtime.env);
    const tools = runtime.createCodingToolset
      ? runtime.createCodingToolset()
      : createCodingToolset();
    const timeline = parsed.storageDir ? new FileTimelineStore(parsed.storageDir) : undefined;
    const agent = runtime.createCodingAgent
      ? runtime.createCodingAgent({
          model: providerSetup.binding,
          tools,
          ...(timeline ? { timeline } : {}),
          ...(parsed.systemPrompt ? { systemPrompt: parsed.systemPrompt } : {}),
          ...(parsed.memory.length > 0 ? { memory: parsed.memory } : {}),
          ...(parsed.skills.length > 0 ? { skills: parsed.skills } : {}),
        })
      : createCodingAgent({
          model: providerSetup.binding,
          tools,
          ...(timeline ? { timeline } : {}),
          ...(parsed.systemPrompt ? { systemPrompt: parsed.systemPrompt } : {}),
          ...(parsed.memory.length > 0 ? { memory: parsed.memory } : {}),
          ...(parsed.skills.length > 0 ? { skills: parsed.skills } : {}),
        });

    const stream = agent.stream({
      messages: [
        {
          id: "msg_cli_input",
          messageId: "msg_cli_input",
          role: "user",
          content: parsed.prompt,
          createdAt: new Date().toISOString(),
          source: "input",
        },
      ],
      metadata: {
        workspaceRoot,
      },
    });
    const renderState = createStreamRenderState();

    while (true) {
      const next = await stream.next();
      if (next.done) {
        return finalizeStreamOutput(next.value, runtime, renderState);
      }
      renderStreamEvent(next.value, runtime, renderState);
    }
  } catch (error) {
    writeLine(runtime.stderr, error instanceof Error ? error.message : String(error));
    return 1;
  }
};
