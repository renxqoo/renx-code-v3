import type { AgentMessage } from "@renx/model";

import type { ContextRuntimeState } from "./types";

const APPROX_CHARS_PER_TOKEN = 4;
const JSON_APPROX_CHARS_PER_TOKEN = 3;

const estimateTextTokens = (value: string): number => {
  if (value.length === 0) return 0;
  return Math.ceil(value.length / APPROX_CHARS_PER_TOKEN);
};

const looksLikeJsonPayload = (value: string): boolean => {
  const text = value.trim();
  if (text.length < 2) return false;
  const startsAsJson =
    (text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"));
  if (!startsAsJson) return false;
  return text.includes('":') || text.includes("},{") || text.includes(":[");
};

const estimateContentTokens = (value: string): number => {
  if (!looksLikeJsonPayload(value)) return estimateTextTokens(value);
  return Math.ceil(value.length / JSON_APPROX_CHARS_PER_TOKEN);
};

export const estimateMessagesTokens = (messages: AgentMessage[]): number => {
  let sum = 0;
  for (const message of messages) {
    sum += estimateContentTokens(message.content);
    if (message.toolCalls && message.toolCalls.length > 0) {
      sum += estimateContentTokens(JSON.stringify(message.toolCalls));
    }
  }
  return sum;
};

export const estimateToolsTokens = (
  tools: Array<{ name: string; description?: string }>,
): number => {
  let sum = 0;
  for (const tool of tools) {
    sum += estimateTextTokens(tool.name);
    if (tool.description) sum += estimateTextTokens(tool.description);
  }
  return sum;
};

export const estimateInputTokens = (input: {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: Array<{ name: string; description?: string }>;
  state: ContextRuntimeState;
}): number => {
  // Hybrid accounting: base estimation + correction from last known usage.
  const estimate =
    estimateTextTokens(input.systemPrompt) +
    estimateMessagesTokens(input.messages) +
    estimateToolsTokens(input.tools);

  const lastUsage = input.state.lastKnownUsage?.inputTokens;
  if (lastUsage === undefined) return estimate;
  const anchorMessageCount = input.state.lastUsageAnchorMessageCount;
  if (anchorMessageCount === undefined || anchorMessageCount <= 0) return estimate;
  if (input.messages.length <= anchorMessageCount) return estimate;
  const deltaMessageCount = input.messages.length - anchorMessageCount;
  const avgTokensPerMessage = estimate / Math.max(1, input.messages.length);
  const incrementalDelta = Math.ceil(avgTokensPerMessage * deltaMessageCount);
  return lastUsage + incrementalDelta;
};
