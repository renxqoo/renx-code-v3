import type { AgentStatus } from "./types";
/**
 * Returns true if the status is terminal (no further processing).
 */
export declare const isTerminalStatus: (status: AgentStatus) => boolean;
/**
 * Returns true if the status represents a pause point
 * (checkpoint saved, control returned to caller).
 */
export declare const shouldPause: (status: AgentStatus) => boolean;
//# sourceMappingURL=helpers.d.ts.map