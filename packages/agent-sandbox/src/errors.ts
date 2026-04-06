import type { SandboxFileErrorCode } from "./types";

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export class SandboxPolicyError extends SandboxError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, "SANDBOX_POLICY_ERROR", metadata);
    this.name = "SandboxPolicyError";
  }
}

export class SandboxPlatformError extends SandboxError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, "SANDBOX_PLATFORM_ERROR", metadata);
    this.name = "SandboxPlatformError";
  }
}

export class SandboxProviderError extends SandboxError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, "SANDBOX_PROVIDER_ERROR", metadata);
    this.name = "SandboxProviderError";
  }
}

export class SandboxLifecycleError extends SandboxError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, "SANDBOX_LIFECYCLE_ERROR", metadata);
    this.name = "SandboxLifecycleError";
  }
}

export class SandboxFileOperationError extends SandboxError {
  constructor(
    readonly path: string,
    readonly fileCode: SandboxFileErrorCode | string,
    message?: string,
  ) {
    super(
      message ?? `Sandbox file operation failed for ${path}: ${fileCode}`,
      "SANDBOX_FILE_OPERATION_ERROR",
      { path, fileCode },
    );
    this.name = "SandboxFileOperationError";
  }
}
