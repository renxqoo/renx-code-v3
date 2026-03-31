export type AgentErrorCode =
  | "MODEL_ERROR"
  | "TOOL_ERROR"
  | "TOOL_NOT_FOUND"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED"
  | "CHECKPOINT_ERROR"
  | "VALIDATION_ERROR"
  | "MAX_STEPS_EXCEEDED"
  | "SYSTEM_ERROR";

export interface AgentErrorInit {
  code: AgentErrorCode;
  message: string;
  cause?: unknown;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
}

export class AgentError extends Error {
  override readonly name = "AgentError";
  readonly code: AgentErrorCode;
  override readonly cause?: unknown;
  readonly retryable: boolean;
  readonly metadata?: Record<string, unknown>;

  constructor(init: AgentErrorInit) {
    super(init.message);
    this.code = init.code;
    if (init.cause !== undefined) {
      this.cause = init.cause;
    }
    this.retryable = init.retryable ?? false;
    if (init.metadata !== undefined) {
      this.metadata = init.metadata;
    }
  }
}
