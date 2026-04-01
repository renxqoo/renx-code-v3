import type { AgentState } from "../types";

import type { MessageStatePatch, RunMessage } from "./types";

/**
 * Immutable message reducer — append or replace.
 */
export const applyMessagePatch = (state: AgentState, patch: MessageStatePatch): AgentState => {
  if (patch.replaceMessages) {
    return { ...state, messages: patch.replaceMessages };
  }

  if (patch.appendMessages?.length) {
    return { ...state, messages: [...state.messages, ...patch.appendMessages] };
  }

  return state;
};

/**
 * Helper to create an append-only patch.
 */
export const appendMessages = (messages: RunMessage[]): MessageStatePatch => ({
  appendMessages: messages,
});

/**
 * Helper to create a replace patch.
 */
export const replaceMessages = (messages: RunMessage[]): MessageStatePatch => ({
  replaceMessages: messages,
});
