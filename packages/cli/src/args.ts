import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CliCommand, CliRunCommand } from "./types";

const DEFAULT_MODEL = "openrouter:qwen/qwen3.6-plus:free";

const isFlag = (value: string): boolean => value.startsWith("-");

const expectValue = (argv: string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (!value || isFlag(value)) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
};

const pushRepeatingValue = (
  argv: string[],
  index: number,
  flag: string,
  target: string[],
): number => {
  target.push(expectValue(argv, index, flag));
  return index + 1;
};

export const parseCliArgs = (argv: string[], cwd: string = process.cwd()): CliCommand => {
  let model = DEFAULT_MODEL;
  let workspaceCwd = cwd;
  let storageDir = resolve(join(homedir(), ".renx-code"));
  let provider: string | undefined;
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let endpoint: string | undefined;
  let systemPrompt: string | undefined;
  let timeoutMs: number | undefined;
  const memory: string[] = [];
  const skills: string[] = [];
  const promptParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    if (current === "--help" || current === "-h") {
      return { command: "help" };
    }
    if (current === "--model") {
      model = expectValue(argv, index, current);
      index += 1;
      continue;
    }
    if (current === "--cwd") {
      workspaceCwd = resolve(expectValue(argv, index, current));
      index += 1;
      continue;
    }
    if (current === "--storage-dir") {
      storageDir = resolve(expectValue(argv, index, current));
      index += 1;
      continue;
    }
    if (current === "--provider") {
      provider = expectValue(argv, index, current);
      index += 1;
      continue;
    }
    if (current === "--api-key") {
      apiKey = expectValue(argv, index, current);
      index += 1;
      continue;
    }
    if (current === "--base-url") {
      baseUrl = expectValue(argv, index, current);
      index += 1;
      continue;
    }
    if (current === "--endpoint") {
      endpoint = expectValue(argv, index, current);
      index += 1;
      continue;
    }
    if (current === "--system-prompt") {
      systemPrompt = expectValue(argv, index, current);
      index += 1;
      continue;
    }
    if (current === "--timeout-ms") {
      const raw = expectValue(argv, index, current);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid timeout for ${current}: ${raw}`);
      }
      timeoutMs = parsed;
      index += 1;
      continue;
    }
    if (current === "--memory") {
      index = pushRepeatingValue(argv, index, current, memory);
      continue;
    }
    if (current === "--skill" || current === "--skills") {
      index = pushRepeatingValue(argv, index, current, skills);
      continue;
    }
    if (current.startsWith("-")) {
      throw new Error(`Unknown option: ${current}`);
    }
    promptParts.push(current);
  }

  const defaultSkillsDir = resolve(join(storageDir, "skills"));
  const mergedSkills = [...new Set([defaultSkillsDir, ...skills.map((entry) => resolve(entry))])];

  return {
    command: "run",
    model,
    cwd: workspaceCwd,
    prompt: promptParts.join(" ").trim(),
    storageDir,
    ...(provider ? { provider } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    memory,
    skills: mergedSkills,
  } satisfies CliRunCommand;
};

export const renderCliHelp = (): string =>
  [
    "Usage: renx-code [options] <prompt>",
    "",
    "Options:",
    "  --model <name>          Model name. Default: gpt-5.4",
    "  --cwd <path>            Workspace root for coding tools. Default: current directory",
    `  --storage-dir <path>    Persist timeline state under this directory. Default: ${resolve(join(homedir(), ".renx-code"))}`,
    "  --provider <name>       Force one provider: openai | openrouter | qwen | kimi | glm | minimax",
    "  --api-key <value>       Override API key for the forced provider",
    "  --base-url <url>        Provider base URL for qwen | kimi | glm | minimax",
    "  --endpoint <url>        Full endpoint override for openai | openrouter",
    "  --system-prompt <text>  Extra system prompt prefix",
    "  --memory <path>         Add memory source path, repeatable",
    "  --skill <path>          Add skills source path, repeatable",
    "  --timeout-ms <number>   Provider request timeout",
    "  --help, -h              Show this help text",
    "",
    "Environment keys:",
    "  OPENAI_API_KEY",
    "  OPENROUTER_API_KEY",
    "  DASHSCOPE_API_KEY / QWEN_API_KEY",
    "  MOONSHOT_API_KEY / KIMI_API_KEY",
    "  GLM_API_KEY",
    "  MINIMAX_API_KEY",
  ].join("\n");
