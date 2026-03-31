export type AgentErrorCode = "MODEL_ERROR" | "TOOL_ERROR" | "TOOL_NOT_FOUND" | "POLICY_DENIED" | "APPROVAL_REQUIRED" | "CHECKPOINT_ERROR" | "VALIDATION_ERROR" | "MAX_STEPS_EXCEEDED" | "SYSTEM_ERROR";
export interface AgentErrorInit {
    code: AgentErrorCode;
    message: string;
    cause?: unknown;
    retryable?: boolean;
    metadata?: Record<string, unknown>;
}
export declare class AgentError extends Error {
    readonly name = "AgentError";
    readonly code: AgentErrorCode;
    readonly cause?: unknown;
    readonly retryable: boolean;
    readonly metadata?: Record<string, unknown>;
    constructor(init: AgentErrorInit);
}
//# sourceMappingURL=errors.d.ts.map