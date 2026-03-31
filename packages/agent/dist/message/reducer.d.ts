import type { AgentMessage } from "@renx/model";
import type { AgentState } from "../types";
import type { MessageStatePatch } from "./types";
/**
 * Immutable message reducer — append or replace.
 */
export declare const applyMessagePatch: (state: AgentState, patch: MessageStatePatch) => AgentState;
/**
 * Helper to create an append-only patch.
 */
export declare const appendMessages: (messages: AgentMessage[]) => MessageStatePatch;
/**
 * Helper to create a replace patch.
 */
export declare const replaceMessages: (messages: AgentMessage[]) => MessageStatePatch;
//# sourceMappingURL=reducer.d.ts.map