import type { ToolResult } from "./types";

type ToolErrorIssue = {
  path?: unknown;
  message?: unknown;
  expected?: unknown;
  received?: unknown;
};

const formatIssuePath = (path: unknown): string => {
  if (!Array.isArray(path) || path.length === 0) return "(root)";
  return path.map((segment) => String(segment)).join(".");
};

const formatIssueLine = (issue: ToolErrorIssue): string => {
  const path = formatIssuePath(issue.path);
  const message =
    typeof issue.message === "string" && issue.message.trim().length > 0
      ? issue.message
      : "Invalid input.";
  return `- ${path}: ${message}`;
};

const buildReadableErrorContent = (
  toolName: string,
  errorCode: string,
  message: string,
  details: unknown,
): string => {
  const lines = [`Tool "${toolName}" failed with ${errorCode}.`, message];
  const issues =
    details &&
    typeof details === "object" &&
    Array.isArray((details as { issues?: unknown[] }).issues)
      ? ((details as { issues: ToolErrorIssue[] }).issues ?? [])
      : [];

  if (issues.length > 0) {
    lines.push("Issues:");
    for (const issue of issues) {
      lines.push(formatIssueLine(issue));
    }
  }

  return lines.join("\n");
};

export const buildToolErrorResult = (input: {
  toolName: string;
  toolCallId: string;
  errorCode: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}): ToolResult => {
  const structured = {
    ok: false,
    error: {
      code: input.errorCode,
      message: input.message,
      retryable: input.retryable ?? false,
      ...(input.details !== undefined ? { details: input.details } : {}),
    },
  };

  return {
    content: buildReadableErrorContent(
      input.toolName,
      input.errorCode,
      input.message,
      input.details,
    ),
    structured,
    metadata: {
      ok: false,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      errorCode: input.errorCode,
    },
  };
};
