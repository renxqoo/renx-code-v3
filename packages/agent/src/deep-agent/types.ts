import type { ModelBinding } from "@renx/model";
import type { ZodType } from "zod";

import type { ContextManagerConfig } from "../context/types";
import type { AgentMiddleware } from "../middleware/types";
import type { MemorySnapshot, MemorySubsystem } from "../memory";
import type { RuntimeConfig } from "../runtime/config";
import type { SkillsSubsystem } from "../skills";
import type {
  AgentCompactOptions,
  AgentCompactResult,
  AgentIdentity,
  AgentInput,
  AgentState,
  AgentResult,
  AgentRunContext,
  AgentResumeSnapshot,
  AgentStreamEvent,
  ApprovalEngine,
  AuditLogger,
  ContextLifecycleHooks,
  Metadata,
  ResumeAtOptions,
  SessionMemoryRecord,
  SessionMemorySubsystem,
  TimelineStore,
} from "../types";
import type { AgentTool, BackendResolver, ExecutionBackend } from "../tool/types";
import type { ApprovalApproverScope } from "../approval/rule-based";

export interface DeepAgentHandle {
  invoke(input: AgentInput, options?: DeepAgentInvocationOptions): Promise<AgentResult>;
  stream(
    input: AgentInput,
    options?: DeepAgentInvocationOptions,
  ): AsyncGenerator<AgentStreamEvent, AgentResult>;
  resume(runId: string): Promise<AgentResult>;
  resumeAt(runId: string, nodeId: string, options?: ResumeAtOptions): Promise<AgentResult>;
  compact(runId: string, options?: AgentCompactOptions): Promise<AgentCompactResult>;
  extractSessionMemory(runId: string): Promise<SessionMemoryRecord>;
  loadResumeSnapshot(runId: string): Promise<AgentResumeSnapshot>;
  loadResumeSnapshotAt(runId: string, nodeId: string): Promise<AgentResumeSnapshot>;
  loadMemorySnapshot(runId: string): Promise<unknown>;
}

export interface DeepAgentBackendIntegration {
  backend: DeepAgentBackendSource;
  middleware?: AgentMiddleware[];
}

export interface DeepAgentInvocationOptions {
  maxSteps?: number;
  recursionLimit?: number;
}

export interface DeepAgentBackendFactoryInput {
  state: AgentState;
  store?: unknown;
}

export type DeepAgentBackendFactory = (
  config: DeepAgentBackendFactoryInput,
) => ExecutionBackend | Promise<ExecutionBackend>;

export type DeepAgentBackendSource = ExecutionBackend | BackendResolver | DeepAgentBackendFactory;

export type DeepAgentBackend = DeepAgentBackendSource | DeepAgentBackendIntegration;

export interface DeepAgentInterruptConfig {
  reason?: string;
  approverScope?: ApprovalApproverScope;
}

export type DeepAgentInterruptOn = Record<string, boolean | DeepAgentInterruptConfig>;

export type DeepAgentResponseFormat = ZodType<unknown> | Record<string, unknown>;

export interface DeepAgentCompiledSubagent {
  name: string;
  description: string;
  runnable: DeepAgentHandle;
}

export interface DeepAgentInlineSubagent {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: AgentTool[];
  model?: ModelBinding | string;
  maxSteps?: number;
  middleware?: AgentMiddleware[];
  interruptOn?: DeepAgentInterruptOn;
  memory?: string[];
  skills?: string[];
  responseFormat?: DeepAgentResponseFormat;
}

export type DeepAgentSubagent = DeepAgentCompiledSubagent | DeepAgentInlineSubagent;

export interface CreateDeepAgentOptions {
  model: ModelBinding | string;
  systemPrompt?: string | ((ctx: AgentRunContext) => string | Promise<string>);
  tools?: AgentTool[];
  middleware?: AgentMiddleware[];
  backend?: DeepAgentBackend;
  store?: unknown;
  interruptOn?: DeepAgentInterruptOn;
  subagents?: DeepAgentSubagent[];
  responseFormat?: DeepAgentResponseFormat;
  contextSchema?: ZodType<unknown>;
  checkpointer?: boolean | TimelineStore;
  name?: string;
  maxSteps?: number;
  timeline?: TimelineStore;
  audit?: AuditLogger;
  approval?: ApprovalEngine;
  memory?: string[];
  skills?: string[];
  workingMemory?: MemorySnapshot;
  memorySubsystem?: MemorySubsystem;
  skillsSubsystem?: SkillsSubsystem;
  sessionMemory?: SessionMemorySubsystem;
  context?: Partial<ContextManagerConfig>;
  retry?: RuntimeConfig["retry"];
  contextLifecycleHooks?: ContextLifecycleHooks;
  identity?: AgentIdentity;
  metadata?: Metadata;
  initializeRunContext?: (
    ctx: AgentRunContext,
    input: AgentInput,
  ) => AgentRunContext | Promise<AgentRunContext>;
}
