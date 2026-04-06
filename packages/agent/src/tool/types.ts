import type { Metadata, ToolCall } from "@renx/model";
import type { ZodType } from "zod";

import type { AgentRunContext, AgentStatePatch } from "../types";
import type { ToolCapabilityProfile } from "./capability";

// --- Tool Result ---

export interface ToolResult {
  content: string;
  structured?: unknown;
  metadata?: Metadata;
  statePatch?: AgentStatePatch;
}

// --- Tool Context ---

export interface ToolContext {
  runContext: AgentRunContext;
  toolCall: ToolCall;
  backend: ExecutionBackend | undefined;
  tools?: {
    list(): AgentTool[];
    get(name: string): AgentTool | undefined;
    invoke(request: {
      name: string;
      input: unknown;
      id?: string;
      runContext?: AgentRunContext;
    }): Promise<ToolExecutionResult>;
  };
  metadata?: Metadata;
}

// --- Tool Protocol ---

export interface AgentTool {
  name: string;
  description: string;
  schema?: ZodType<unknown>;
  inputJsonSchema?: Record<string, unknown>;
  capabilities?: string[];
  profile?: ToolCapabilityProfile;
  maxResultSizeChars?: number;
  invoke(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  isConcurrencySafe?(input: unknown): boolean;
  isReadOnly?(input: unknown): boolean;
}

// --- Execution Result ---

export interface ToolExecutionResult {
  tool: AgentTool;
  call: ToolCall;
  output: ToolResult;
}

// --- Tool Registry ---

export interface ToolRegistry {
  register(tool: AgentTool): void;
  get(name: string): AgentTool | undefined;
  list(): AgentTool[];
}

// --- Execution Backend ---

export interface BackendCapabilities {
  exec: boolean;
  filesystemRead: boolean;
  filesystemWrite: boolean;
  network?: boolean;
  persistentSession?: boolean;
  binaryRead?: boolean;
  pathMetadata?: boolean;
  snapshots?: boolean;
  cancellation?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  sessionId?: string;
  stdin?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs?: number;
  sessionId?: string;
}

export interface FileInfo {
  path: string;
  isDirectory?: boolean;
  size?: number;
  modifiedAt?: string;
  sha256?: string;
}

export interface BackendSession {
  id: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateSessionOptions {
  cwd?: string;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface ExecutionBackend {
  kind: string;
  capabilities(): BackendCapabilities;
  exec?(command: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile?(path: string): Promise<string>;
  readBinaryFile?(path: string): Promise<Uint8Array>;
  writeFile?(path: string, content: string): Promise<void>;
  listFiles?(path: string): Promise<FileInfo[]>;
  statPath?(path: string): Promise<FileInfo | undefined>;
  createSession?(options?: CreateSessionOptions): Promise<BackendSession>;
  closeSession?(sessionId: string): Promise<void>;
}

// --- Backend Resolver ---

export interface BackendResolver {
  resolve(
    ctx: AgentRunContext,
    tool: AgentTool,
    call: ToolCall,
  ): Promise<ExecutionBackend | undefined> | ExecutionBackend | undefined;
}
