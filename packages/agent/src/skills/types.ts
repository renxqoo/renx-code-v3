import type { Metadata } from "@renx/model";

import type { RunMessage } from "../message/types";
import type { AgentRunContext, AgentStatePatch } from "../types";
import type { ToolContext, ToolResult } from "../tool/types";

export type SkillSource = "project" | "user" | "plugin" | "builtin";
export type SkillExecutionMode = "inline" | "fork";
export type SkillShell = "bash" | "powershell";

export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  path: string;
  source: SkillSource;
  tags: string[];
  aliases: string[];
  keywords: string[];
  userInvocable: boolean;
  executionMode: SkillExecutionMode;
  model?: string;
  shell?: SkillShell;
  tools?: string[];
  disallowedTools?: string[];
  inputGlobs?: string[];
  hooks?: Record<string, unknown>;
  subagent?: string;
  metadata?: Metadata;
}

export interface SkillSourceConfig {
  path: string;
  source?: SkillSource;
  priority?: number;
}

export interface SkillDiscoveryRequest {
  query: string;
  touchedPaths?: string[];
  limit?: number;
}

export interface SkillDiscoveryResult {
  matches: SkillDefinition[];
  query: string;
}

export interface SkillInvocationRecord {
  skillName: string;
  skillPath: string;
  executionMode: SkillExecutionMode;
  invokedAt: string;
  args?: string;
}

export interface SkillsRuntimeState {
  invoked: SkillInvocationRecord[];
}

export interface SkillExecutionRequest {
  skill: string;
  args?: string;
}

export interface SkillExecutionResult extends ToolResult {
  structured?: {
    skillName: string;
    skillPath: string;
    executionMode: SkillExecutionMode;
    args?: string;
    delegatedToTask?: boolean;
    taskResult?: unknown;
  };
}

export interface SkillRegistry {
  list(): SkillDefinition[];
  resolve(name: string): SkillDefinition | undefined;
  discover(request: SkillDiscoveryRequest): SkillDiscoveryResult;
  refresh?(): void;
  version?(): string;
}

export interface SkillsConfig {
  includeAvailableListing: boolean;
  includeRelevantSkills: boolean;
  includeInvokedSummary: boolean;
  maxAvailableSkills: number;
  maxRelevantSkills: number;
  maxInvokedSkills: number;
}

export interface SkillHooks {
  onSkillsLoaded?(skills: SkillDefinition[]): Promise<void> | void;
  onSkillInvoked?(record: SkillInvocationRecord, skill: SkillDefinition): Promise<void> | void;
  onSkillsDiscovered?(result: SkillDiscoveryResult): Promise<void> | void;
}

export interface SkillsSubsystem {
  registry: SkillRegistry;
  config?: Partial<SkillsConfig>;
  hooks?: SkillHooks;
}

export interface SkillExecutionContext {
  runContext: AgentRunContext;
  toolContext?: ToolContext;
}

export interface SkillsService {
  list(): SkillDefinition[];
  discover(request: SkillDiscoveryRequest): SkillDiscoveryResult;
  buildPromptMessages(runContext: AgentRunContext, messages: RunMessage[]): RunMessage[];
  createInvocationStatePatch(
    runContext: AgentRunContext,
    record: SkillInvocationRecord,
  ): AgentStatePatch;
  invoke(
    request: SkillExecutionRequest,
    context: SkillExecutionContext,
  ): Promise<SkillExecutionResult>;
}
