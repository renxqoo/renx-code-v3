import type { AgentMessage } from "@renx/model";

export const applyMicrocompact = (
  messages: AgentMessage[],
  maxToolChars: number,
  currentRoundIndex: number,
): AgentMessage[] => {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    const withRound = message as AgentMessage & { roundIndex?: number };
    const messageRound = typeof withRound.roundIndex === "number" ? withRound.roundIndex : 0;
    const isCold = messageRound < currentRoundIndex - 2;
    if (!isCold || message.content.length <= maxToolChars) return message;

    return {
      ...message,
      content: `${message.content.slice(0, maxToolChars)}\n...[microcompact truncated]`,
    };
  });
};
