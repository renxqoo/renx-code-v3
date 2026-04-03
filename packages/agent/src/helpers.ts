import type { AgentStatus } from "./types";

/**
 * Generate an agent-layer ID with optional prefix.
 * Centralizes ID generation so format changes propagate globally.
 */
export const generateId = (prefix?: string): string => {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
};

/**
 * Returns true if the status is terminal (no further processing).
 */
export const isTerminalStatus = (status: AgentStatus): boolean =>
  status === "completed" || status === "failed";

/**
 * Returns true if the status represents a pause point
 * (timeline snapshot saved, control returned to caller).
 */
export const shouldPause = (status: AgentStatus): boolean =>
  status === "waiting_approval" || status === "interrupted";
