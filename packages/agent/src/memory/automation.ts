import { createMemorySnapshot } from "./snapshot";
import type { MemoryAutomationConfig, MemorySnapshot, ResolvedMemorySnapshot } from "./types";
import type { RunMessage } from "../message/types";

export const DEFAULT_MEMORY_AUTOMATION_CONFIG: MemoryAutomationConfig = {
  minimumMessages: 6,
  maxConversationMessages: 24,
  targetScope: "project",
};

export const mergeMemoryAutomationConfig = (
  overrides?: Partial<MemoryAutomationConfig>,
): MemoryAutomationConfig => ({
  ...DEFAULT_MEMORY_AUTOMATION_CONFIG,
  ...overrides,
});

export const shouldAutoSaveMemory = (
  snapshot: MemorySnapshot | undefined,
  messages: RunMessage[],
  overrides?: Partial<MemoryAutomationConfig>,
): { shouldAutoSave: boolean; reason?: string } => {
  const config = mergeMemoryAutomationConfig(overrides);
  if (messages.length < config.minimumMessages) {
    return { shouldAutoSave: false, reason: "minimum_messages_not_met" };
  }
  const latestMessageId = messages[messages.length - 1]?.id;
  const current = createMemorySnapshot(snapshot);
  if (latestMessageId && current.automation?.lastAutoSavedMessageId === latestMessageId) {
    return { shouldAutoSave: false, reason: "already_processed_latest_message" };
  }
  return { shouldAutoSave: true };
};

export const buildMemoryAutomationWindow = (
  messages: RunMessage[],
  overrides?: Partial<MemoryAutomationConfig>,
): RunMessage[] => {
  const config = mergeMemoryAutomationConfig(overrides);
  return messages.slice(-config.maxConversationMessages);
};

export const markMemoryAutoSaved = (
  snapshot: MemorySnapshot | undefined,
  latestMessageId: string | undefined,
  timestamp: string,
): ResolvedMemorySnapshot =>
  createMemorySnapshot({
    ...createMemorySnapshot(snapshot),
    automation: {
      ...(latestMessageId ? { lastAutoSavedMessageId: latestMessageId } : {}),
      lastAutoSavedAt: timestamp,
    },
  });
