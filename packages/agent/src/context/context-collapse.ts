import type { AgentMessage } from "@renx/model";
import type { ContextRuntimeState } from "./types";

export const applyContextCollapse = (
  messages: AgentMessage[],
  state: ContextRuntimeState,
): { messages: AgentMessage[]; nextState: ContextRuntimeState } => {
  if (messages.length < 12) return { messages, nextState: state };

  const head = messages.slice(0, 3);
  const tail = messages.slice(-6);
  const middle = messages.slice(3, -6);

  if (middle.length < 4) return { messages, nextState: state };

  const segmentId = `collapse_segment_${Date.now()}`;
  const collapseMessage: AgentMessage = {
    id: `collapse_${Date.now()}`,
    role: "system",
    createdAt: new Date().toISOString(),
    content: `[Context Collapse] ${middle.length} messages folded. Keep recent context and use preserved summary for continuity.`,
    metadata: {
      collapsedCount: middle.length,
      segmentId,
    },
  };

  return {
    messages: [...head, collapseMessage, ...tail],
    nextState: {
      ...state,
      contextCollapseState: {
        collapsedMessageIds: middle.map((m) => m.id),
        lastCollapsedAt: new Date().toISOString(),
        segments: {
          ...state.contextCollapseState?.segments,
          [segmentId]: {
            createdAt: new Date().toISOString(),
            messageIds: middle.map((m) => m.id),
            messages: middle,
          },
        },
      },
    },
  };
};

export const restoreCollapsedContext = (
  messages: AgentMessage[],
  state: ContextRuntimeState,
  maxRestoreMessages = 6,
  restoreTokenBudget = Number.MAX_SAFE_INTEGER,
): { messages: AgentMessage[]; nextState: ContextRuntimeState; restored: boolean } => {
  const collapseState = state.contextCollapseState;
  if (!collapseState) return { messages, nextState: state, restored: false };
  if (Object.keys(collapseState.segments).length === 0) {
    return { messages, nextState: state, restored: false };
  }

  const collapseIdx = messages.findIndex(
    (m) => m.id.startsWith("collapse_") || typeof m.metadata?.["segmentId"] === "string",
  );
  if (collapseIdx < 0) return { messages, nextState: state, restored: false };
  const segmentId =
    typeof messages[collapseIdx]?.metadata?.["segmentId"] === "string"
      ? String(messages[collapseIdx]?.metadata?.["segmentId"])
      : undefined;
  if (!segmentId) return { messages, nextState: state, restored: false };

  const segment = collapseState.segments[segmentId];
  if (!segment) return { messages, nextState: state, restored: false };
  const restoredMiddle = selectMessagesByTokenBudget(
    segment.messages,
    maxRestoreMessages,
    restoreTokenBudget,
  );
  if (restoredMiddle.length === 0) return { messages, nextState: state, restored: false };

  const nextMessages = [
    ...messages.slice(0, collapseIdx),
    ...restoredMiddle,
    ...messages.slice(collapseIdx + 1),
  ];
  const nextSegments = { ...collapseState.segments };
  delete nextSegments[segmentId];
  return {
    messages: nextMessages,
    restored: true,
    nextState: {
      ...state,
      contextCollapseState: {
        ...collapseState,
        collapsedMessageIds: [],
        lastRestoredAt: new Date().toISOString(),
        segments: nextSegments,
      },
    },
  };
};

const selectMessagesByTokenBudget = (
  source: AgentMessage[],
  maxMessages: number,
  tokenBudget: number,
): AgentMessage[] => {
  if (source.length === 0 || maxMessages <= 0 || tokenBudget <= 0) return [];
  const selected: AgentMessage[] = [];
  let remaining = tokenBudget;

  for (let i = source.length - 1; i >= 0 && selected.length < maxMessages; i -= 1) {
    const candidate = source[i];
    if (!candidate) continue;
    const est = estimateMessageTokens(candidate);
    if (est > remaining && selected.length > 0) break;
    if (est > remaining && selected.length === 0) continue;
    selected.push(candidate);
    remaining -= est;
  }

  return selected.reverse();
};

const estimateMessageTokens = (message: AgentMessage): number => {
  // Keep estimator lightweight and consistent with main budgeting heuristic.
  return Math.max(1, Math.ceil(message.content.length / 4));
};
