import type { AgentMessage, Metadata, ModelResponse, ToolCall } from "@renx/model";
export type { Metadata } from "@renx/model";
import type { AgentError } from "./errors";
import type { AgentTool, ToolResult } from "./tool/types";
export type { AgentTool, ToolResult, ToolContext, ToolExecutionResult, ToolRegistry, BackendResolver, ExecutionBackend } from "./tool/types";
export type AgentStatus = "running" | "completed" | "failed" | "interrupted" | "waiting_approval";
export interface AgentState {
    runId: string;
    threadId?: string;
    messages: AgentMessage[];
    scratchpad: Metadata;
    memory: Metadata;
    stepCount: number;
    status: AgentStatus;
    lastModelResponse?: ModelResponse;
    lastToolCall?: ToolCall;
    lastToolResult?: ToolResult;
    error?: AgentError;
}
export interface AgentStatePatch {
    appendMessages?: AgentMessage[];
    setScratchpad?: Metadata;
    mergeMemory?: Metadata;
    setStatus?: AgentStatus;
    setError?: AgentError;
}
export interface AgentIdentity {
    userId: string;
    tenantId: string;
    roles: string[];
    sessionId?: string;
}
export interface AgentInput {
    messages?: AgentMessage[];
    inputText?: string;
    metadata?: Metadata;
}
export interface CheckpointStore {
    load(runId: string): Promise<CheckpointRecord | null>;
    save(record: CheckpointRecord): Promise<void>;
    delete?(runId: string): Promise<void>;
}
export interface AuditLogger {
    log(event: AuditEvent): Promise<void> | void;
}
export interface ApprovalService {
    create(request: ApprovalRequest): Promise<void>;
    get(requestId: string): Promise<ApprovalDecision | null>;
}
export interface MemoryStore {
    load(ctx: AgentRunContext): Promise<Metadata> | Metadata;
    save?(ctx: AgentRunContext, patch: Metadata): Promise<void> | void;
}
export interface PolicyEngine {
    filterTools(ctx: AgentRunContext, tools: AgentTool[]): Promise<AgentTool[]> | AgentTool[];
    canUseTool(ctx: AgentRunContext, tool: AgentTool, input: unknown): Promise<boolean> | boolean;
    needApproval?(ctx: AgentRunContext, tool: AgentTool, input: unknown): Promise<boolean> | boolean;
    redactOutput?(ctx: AgentRunContext, output: string): Promise<string> | string;
}
export interface CheckpointRecord {
    runId: string;
    state: AgentState;
    metadata?: Metadata;
    createdAt: string;
    updatedAt: string;
}
export type AuditEventType = "run_started" | "model_called" | "model_returned" | "tool_called" | "tool_succeeded" | "tool_failed" | "approval_requested" | "approval_resolved" | "run_completed" | "run_failed";
export interface AuditEvent {
    id: string;
    runId: string;
    type: AuditEventType;
    timestamp: string;
    actor?: string;
    payload: Record<string, unknown>;
}
export interface ApprovalRequest {
    id: string;
    runId: string;
    toolName: string;
    input: unknown;
    reason: string;
    createdAt: string;
}
export interface ApprovalDecision {
    requestId: string;
    approved: boolean;
    reviewerId: string;
    comment?: string;
    decidedAt: string;
}
export interface AgentServices {
    checkpoint?: CheckpointStore;
    audit?: AuditLogger;
    approval?: ApprovalService;
    memory?: MemoryStore;
}
export interface AgentRunContext {
    input: AgentInput;
    identity: AgentIdentity;
    state: AgentState;
    services: AgentServices;
    metadata: Metadata;
}
export interface AgentResult {
    runId: string;
    status: AgentStatus;
    output?: string;
    error?: AgentError;
    state: AgentState;
}
export type AgentStreamEvent = {
    type: "run_started";
    runId: string;
} | {
    type: "model_started";
} | {
    type: "assistant_delta";
    text: string;
} | {
    type: "tool_call";
    call: ToolCall;
} | {
    type: "tool_result";
    result: ToolResult;
} | {
    type: "approval_required";
    requestId: string;
} | {
    type: "run_completed";
    output: string;
} | {
    type: "run_failed";
    error: AgentError;
};
//# sourceMappingURL=types.d.ts.map