import type { Metadata, ToolCall } from "@renx/model";
import type { AgentRunContext, AgentStatePatch } from "../types";
export interface ToolResult {
    content: string;
    structured?: unknown;
    metadata?: Metadata;
    statePatch?: AgentStatePatch;
}
export interface ToolContext {
    runContext: AgentRunContext;
    toolCall: ToolCall;
    backend: ExecutionBackend | undefined;
    metadata?: Metadata;
}
export interface AgentTool {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    capabilities?: string[];
    invoke(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
export interface ToolExecutionResult {
    tool: AgentTool;
    call: ToolCall;
    output: ToolResult;
}
export interface ToolRegistry {
    register(tool: AgentTool): void;
    get(name: string): AgentTool | undefined;
    list(): AgentTool[];
}
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
export interface BackendResolver {
    resolve(ctx: AgentRunContext, tool: AgentTool, call: ToolCall): Promise<ExecutionBackend | undefined> | ExecutionBackend | undefined;
}
//# sourceMappingURL=types.d.ts.map