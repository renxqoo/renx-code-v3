import type { RunMessage } from "../message/types";

export interface ApiRoundGroup {
  roundIndex: number;
  messages: RunMessage[];
}

export const groupMessagesByRound = (messages: RunMessage[]): ApiRoundGroup[] => {
  const groups = new Map<number, RunMessage[]>();
  for (const message of messages) {
    const roundIndex = message.roundIndex ?? 0;
    const list = groups.get(roundIndex) ?? [];
    list.push(message);
    groups.set(roundIndex, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([roundIndex, grouped]) => ({ roundIndex, messages: grouped }));
};
