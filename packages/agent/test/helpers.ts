import type { AgentRunContext, AgentState } from "../src/types";

export { generateId } from "../src/helpers";

export const baseState: AgentState = {
  runId: "run_1",
  messages: [],
  scratchpad: {},
  memory: {},
  stepCount: 0,
  status: "running",
};

/**
 * Build an AgentInput that is compatible with exactOptionalPropertyTypes.
 * Optional properties are omitted rather than set to undefined.
 */
export const buildInput = (overrides?: {
  inputText?: string;
  messages?: AgentState["messages"];
}) => {
  const input: { inputText?: string; messages?: AgentState["messages"] } = {};
  if (overrides?.inputText !== undefined) {
    input.inputText = overrides.inputText;
  }
  if (overrides?.messages !== undefined) {
    input.messages = overrides.messages;
  }
  return input;
};

/**
 * Build an AgentRunContext that is compatible with exactOptionalPropertyTypes.
 * Optional properties in input and services are omitted rather than set to undefined.
 */
export const baseCtx = (overrides?: { inputText?: string }): AgentRunContext => ({
  input: buildInput(overrides),
  identity: { userId: "u1", tenantId: "t1", roles: [] },
  state: { ...baseState },
  services: {},
  metadata: {},
});
