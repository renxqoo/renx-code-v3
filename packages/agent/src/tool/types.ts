import type { Metadata, ToolCall } from "@renx/model";

import type { AgentRunContext, AgentStatePatch } from "../types";

// --- Validation Result ---

export type ValidationResult = { result: true } | { result: false; message: string; code?: string };

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
  metadata?: Metadata;
}

// --- Tool Protocol ---

export interface AgentTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  capabilities?: string[];
  maxResultSizeChars?: number;
  invoke(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  isConcurrencySafe?(input: unknown): boolean;
  isReadOnly?(input: unknown): boolean;
  validateInput?(input: unknown, ctx: ToolContext): Promise<ValidationResult> | ValidationResult;
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
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FileInfo {
  path: string;
  isDirectory?: boolean;
  size?: number;
  modifiedAt?: string;
}

export interface ExecutionBackend {
  kind: string;
  capabilities(): BackendCapabilities;
  exec?(command: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile?(path: string): Promise<string>;
  writeFile?(path: string, content: string): Promise<void>;
  listFiles?(path: string): Promise<FileInfo[]>;
}

// --- Backend Resolver ---

export interface BackendResolver {
  resolve(
    ctx: AgentRunContext,
    tool: AgentTool,
    call: ToolCall,
  ): Promise<ExecutionBackend | undefined> | ExecutionBackend | undefined;
}
