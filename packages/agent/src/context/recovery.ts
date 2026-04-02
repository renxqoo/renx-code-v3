import { applyAutoCompact, trimOldestRoundGroups } from "./auto-compact";
import { groupMessagesByRound } from "./grouping";
import type { ContextErrorRecoveryInput, ContextErrorRecoveryResult } from "./types";

export const recoverFromContextError = (
  input: ContextErrorRecoveryInput,
  options?: {
    maxCompactRequestRetries?: number;
    compactRequestMaxInputChars?: number;
    historySnipMaxDropRounds?: number;
  },
): ContextErrorRecoveryResult => {
  const { canonicalMessages, state } = input;
  const compacted = applyAutoCompact([], canonicalMessages, "reactive_compact", {
    maxCompactRequestRetries: options?.maxCompactRequestRetries ?? 2,
    compactRequestMaxInputChars: options?.compactRequestMaxInputChars ?? 20_000,
    historySnipMaxDropRounds: options?.historySnipMaxDropRounds ?? 2,
  });
  if (!compacted.compactedMessageCount && input.reason === "prompt_too_long") {
    const grouped = groupMessagesByRound(canonicalMessages);
    if (grouped.length > 1) {
      const trimmed = trimOldestRoundGroups(
        canonicalMessages,
        options?.historySnipMaxDropRounds ?? 2,
      );
      return {
        recovered: trimmed.length < canonicalMessages.length,
        canonicalMessages: trimmed,
        nextState: {
          ...state,
          promptTooLongRetries: state.promptTooLongRetries + 1,
          lastLayerExecutions: [
            ...state.lastLayerExecutions,
            {
              layer: "reactive_compact",
              beforeTokens: 0,
              afterTokens: 0,
              reason: "prompt_too_long_round_group_trim",
            },
          ],
        },
      };
    }
  }

  return {
    recovered: compacted.canonicalMessages.length < canonicalMessages.length,
    canonicalMessages: compacted.canonicalMessages,
    nextState: {
      ...state,
      promptTooLongRetries: state.promptTooLongRetries + 1,
      lastLayerExecutions: [
        ...state.lastLayerExecutions,
        {
          layer: "reactive_compact",
          beforeTokens: 0,
          afterTokens: 0,
          reason: input.reason,
        },
      ],
    },
  };
};
