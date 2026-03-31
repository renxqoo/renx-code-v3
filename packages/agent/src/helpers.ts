import type { AgentStatus } from "./types";

/**
 * Returns true if the status is terminal (no further processing).
 */
export const isTerminalStatus = (status: AgentStatus): boolean =>
  status === "completed" || status === "failed";

/**
 * Returns true if the status represents a pause point
 * (checkpoint saved, control returned to caller).
 */
export const shouldPause = (status: AgentStatus): boolean =>
  status === "waiting_approval" || status === "interrupted";
