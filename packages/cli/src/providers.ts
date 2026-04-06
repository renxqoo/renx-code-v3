import { createModelBinding } from "@renx/model";
import type { ModelBinding, ModelClient, ModelProvider } from "@renx/model";
import {
  createGlmProvider,
  createKimiProvider,
  createMiniMaxProvider,
  createModelClient,
  createOpenAIProvider,
  createOpenRouterProvider,
  createQwenProvider,
} from "@renx/provider";

import type {
  CliEnvironment,
  CliRunCommand,
  ProviderFactoryOverrides,
  ProviderSetup,
} from "./types";

const getString = (env: CliEnvironment, key: string): string | undefined => {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

const getExplicitOrEnvKey = (
  explicit: string | undefined,
  env: CliEnvironment,
  keys: string[],
): string | undefined =>
  explicit ?? keys.map((key) => getString(env, key)).find((value) => value !== undefined);

const buildSingleProvider = (
  command: CliRunCommand,
  env: CliEnvironment,
  overrides: ProviderFactoryOverrides,
): ModelProvider => {
  const provider = command.provider?.toLowerCase();
  if (!provider) {
    throw new Error("Provider name is required for single-provider resolution.");
  }

  switch (provider) {
    case "openai": {
      const apiKey = getExplicitOrEnvKey(command.apiKey, env, ["OPENAI_API_KEY"]);
      if (!apiKey)
        throw new Error("Missing API key for openai. Set OPENAI_API_KEY or pass --api-key.");
      return (overrides.createOpenAIProvider ?? createOpenAIProvider)({
        apiKey,
        ...(command.endpoint ? { endpoint: command.endpoint } : {}),
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      });
    }
    case "openrouter": {
      const apiKey = getExplicitOrEnvKey(command.apiKey, env, ["OPENROUTER_API_KEY"]);
      if (!apiKey)
        throw new Error(
          "Missing API key for openrouter. Set OPENROUTER_API_KEY or pass --api-key.",
        );
      return (overrides.createOpenRouterProvider ?? createOpenRouterProvider)({
        apiKey,
        ...(command.endpoint ? { endpoint: command.endpoint } : {}),
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      });
    }
    case "qwen": {
      const apiKey = getExplicitOrEnvKey(command.apiKey, env, [
        "DASHSCOPE_API_KEY",
        "QWEN_API_KEY",
      ]);
      if (!apiKey)
        throw new Error("Missing API key for qwen. Set DASHSCOPE_API_KEY or pass --api-key.");
      return (overrides.createQwenProvider ?? createQwenProvider)({
        apiKey,
        ...(command.baseUrl ? { baseURL: command.baseUrl } : {}),
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      });
    }
    case "kimi": {
      const apiKey = getExplicitOrEnvKey(command.apiKey, env, ["MOONSHOT_API_KEY", "KIMI_API_KEY"]);
      if (!apiKey)
        throw new Error("Missing API key for kimi. Set MOONSHOT_API_KEY or pass --api-key.");
      return (overrides.createKimiProvider ?? createKimiProvider)({
        apiKey,
        ...(command.baseUrl ? { baseURL: command.baseUrl } : {}),
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      });
    }
    case "glm": {
      const apiKey = getExplicitOrEnvKey(command.apiKey, env, ["GLM_API_KEY"]);
      if (!apiKey) throw new Error("Missing API key for glm. Set GLM_API_KEY or pass --api-key.");
      return (overrides.createGlmProvider ?? createGlmProvider)({
        apiKey,
        ...(command.baseUrl ? { baseURL: command.baseUrl } : {}),
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      });
    }
    case "minimax": {
      const apiKey = getExplicitOrEnvKey(command.apiKey, env, ["MINIMAX_API_KEY"]);
      if (!apiKey)
        throw new Error("Missing API key for minimax. Set MINIMAX_API_KEY or pass --api-key.");
      return (overrides.createMiniMaxProvider ?? createMiniMaxProvider)({
        apiKey,
        ...(command.baseUrl ? { baseURL: command.baseUrl } : {}),
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      });
    }
    default:
      throw new Error(`Unsupported provider: ${command.provider}`);
  }
};

const collectConfiguredProviders = (
  command: CliRunCommand,
  env: CliEnvironment,
  overrides: ProviderFactoryOverrides,
): ModelProvider[] => {
  const providers: ModelProvider[] = [];
  const openAiKey = getString(env, "OPENAI_API_KEY");
  if (openAiKey) {
    providers.push(
      (overrides.createOpenAIProvider ?? createOpenAIProvider)({
        apiKey: openAiKey,
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      }),
    );
  }
  const openRouterKey = getString(env, "OPENROUTER_API_KEY");
  if (openRouterKey) {
    providers.push(
      (overrides.createOpenRouterProvider ?? createOpenRouterProvider)({
        apiKey: openRouterKey,
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      }),
    );
  }
  const qwenKey = getExplicitOrEnvKey(undefined, env, ["DASHSCOPE_API_KEY", "QWEN_API_KEY"]);
  if (qwenKey) {
    providers.push(
      (overrides.createQwenProvider ?? createQwenProvider)({
        apiKey: qwenKey,
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      }),
    );
  }
  const kimiKey = getExplicitOrEnvKey(undefined, env, ["MOONSHOT_API_KEY", "KIMI_API_KEY"]);
  if (kimiKey) {
    providers.push(
      (overrides.createKimiProvider ?? createKimiProvider)({
        apiKey: kimiKey,
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      }),
    );
  }
  const glmKey = getString(env, "GLM_API_KEY");
  if (glmKey) {
    providers.push(
      (overrides.createGlmProvider ?? createGlmProvider)({
        apiKey: glmKey,
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      }),
    );
  }
  const minimaxKey = getString(env, "MINIMAX_API_KEY");
  if (minimaxKey) {
    providers.push(
      (overrides.createMiniMaxProvider ?? createMiniMaxProvider)({
        apiKey: minimaxKey,
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
      }),
    );
  }
  return providers;
};

export const resolveProviderSetup = (
  command: CliRunCommand,
  env: CliEnvironment,
  overrides: ProviderFactoryOverrides = {},
): ProviderSetup => {
  const providers =
    command.provider !== undefined
      ? [buildSingleProvider(command, env, overrides)]
      : collectConfiguredProviders(command, env, overrides);

  if (providers.length === 0) {
    throw new Error(
      "No model providers configured. Set an API key such as OPENAI_API_KEY or pass --provider with --api-key.",
    );
  }

  const modelClientFactory =
    overrides.createModelClient ??
    ((input: { providers: ModelProvider[] }): ModelClient =>
      createModelClient({ providers: input.providers }));
  const modelBindingFactory =
    overrides.createModelBinding ??
    ((client: ModelClient, name: string): ModelBinding => createModelBinding(client, name));

  const client = modelClientFactory({ providers });
  return {
    providers,
    binding: modelBindingFactory(client, command.model),
  };
};
