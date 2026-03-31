import type { AgentState, AgentStatePatch } from "./types";

/**
 * Immutable state reducer — always returns a new object.
 */
export const applyStatePatch = (state: AgentState, patch?: AgentStatePatch): AgentState => {
  if (!patch) return state;

  return {
    ...state,
    ...(patch.appendMessages ? { messages: [...state.messages, ...patch.appendMessages] } : {}),
    ...(patch.setScratchpad ? { scratchpad: { ...state.scratchpad, ...patch.setScratchpad } } : {}),
    ...(patch.mergeMemory ? { memory: { ...state.memory, ...patch.mergeMemory } } : {}),
    ...(patch.setStatus ? { status: patch.setStatus } : {}),
    ...(patch.setError ? { error: patch.setError } : {}),
  };
};
