import type { DeepAgentHandle, TimelineStore } from "@renx/agent";
import type { AgentTool } from "@renx/agent";
import type { ModelBinding, ModelClient, ModelProvider } from "@renx/model";

export interface CliHelpCommand {
  command: "help";
}

export interface CliRunCommand {
  command: "run";
  model: string;
  prompt: string;
  cwd: string;
  storageDir?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  endpoint?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  memory: string[];
  skills: string[];
}

export type CliCommand = CliHelpCommand | CliRunCommand;

export type CliEnvironment = Record<string, string | undefined>;

export interface ProviderSetup {
  providers: ModelProvider[];
  binding: ModelBinding;
}

export interface CliWriter {
  write(chunk: string): boolean;
}

export interface CliRuntimeDeps {
  cwd: () => string;
  env: CliEnvironment;
  stdout: CliWriter;
  stderr: CliWriter;
  createProviderSetup?: (command: CliRunCommand, env: CliEnvironment) => ProviderSetup;
  createCodingToolset?: () => AgentTool[];
  createCodingAgent?: (options: {
    model: ModelBinding;
    tools: AgentTool[];
    timeline?: TimelineStore;
    systemPrompt?: string;
    memory?: string[];
    skills?: string[];
  }) => DeepAgentHandle;
}

export interface ProviderFactoryOverrides {
  createOpenAIProvider?: (input: {
    apiKey: string;
    endpoint?: string;
    timeoutMs?: number;
  }) => ModelProvider;
  createOpenRouterProvider?: (input: {
    apiKey: string;
    endpoint?: string;
    timeoutMs?: number;
  }) => ModelProvider;
  createQwenProvider?: (input: {
    apiKey: string;
    baseURL?: string;
    endpointPath?: string;
    timeoutMs?: number;
  }) => ModelProvider;
  createKimiProvider?: (input: {
    apiKey: string;
    baseURL?: string;
    endpointPath?: string;
    timeoutMs?: number;
  }) => ModelProvider;
  createGlmProvider?: (input: {
    apiKey: string;
    baseURL?: string;
    endpointPath?: string;
    timeoutMs?: number;
  }) => ModelProvider;
  createMiniMaxProvider?: (input: {
    apiKey: string;
    baseURL?: string;
    endpointPath?: string;
    timeoutMs?: number;
  }) => ModelProvider;
  createModelClient?: (input: { providers: ModelProvider[] }) => ModelClient;
  createModelBinding?: (client: ModelClient, name: string) => ModelBinding;
}
