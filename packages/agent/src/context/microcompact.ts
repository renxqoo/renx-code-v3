import type { AgentMessage } from "@renx/model";

const CLEARED_TOOL_RESULT_MESSAGE = "[Old tool result content cleared]";
const CLEARABLE_TOOL_NAMES = new Set([
  "Bash",
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "PowerShell",
]);

export const applyMicrocompact = (
  messages: AgentMessage[],
  maxToolChars: number,
  currentRoundIndex: number,
  maxAgeMs?: number,
): AgentMessage[] => {
  const latestTimestamp = messages.reduce((latest, message) => {
    const parsed = Date.parse(message.createdAt);
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, 0);
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    const withRound = message as AgentMessage & { roundIndex?: number };
    const messageRound = typeof withRound.roundIndex === "number" ? withRound.roundIndex : 0;
    const ageMs = (() => {
      const parsed = Date.parse(message.createdAt);
      return Number.isFinite(parsed) ? latestTimestamp - parsed : 0;
    })();
    const isColdByRound = messageRound < currentRoundIndex - 2;
    const isColdByAge = typeof maxAgeMs === "number" && maxAgeMs >= 0 && ageMs >= maxAgeMs;
    const isCold = isColdByRound || isColdByAge;
    if (!isCold || message.content.length <= maxToolChars) return message;

    const toolName =
      typeof (message as AgentMessage & { name?: string }).name === "string"
        ? ((message as AgentMessage & { name?: string }).name as string)
        : undefined;
    if (toolName && CLEARABLE_TOOL_NAMES.has(toolName)) {
      return {
        ...message,
        content: CLEARED_TOOL_RESULT_MESSAGE,
        metadata: {
          ...message.metadata,
          microcompactCleared: true,
        },
      };
    }

    return {
      ...message,
      content: `${message.content.slice(0, maxToolChars)}\n...[microcompact truncated]`,
    };
  });
};
