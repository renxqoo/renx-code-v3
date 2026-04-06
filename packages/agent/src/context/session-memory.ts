import type { ModelClient, ModelRequest } from "@renx/model";

import type {
  AgentState,
  SessionMemoryConfig,
  SessionMemoryEvent,
  SessionMemoryExtractor,
  SessionMemoryPromptInput,
  SessionMemoryRecord,
  SessionMemorySubsystem,
} from "../types";
import type { RunMessage } from "../message/types";

const MAX_SECTION_TOKENS = 2_000;
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12_000;

export const DEFAULT_SESSION_MEMORY_TEMPLATE = `# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`;

export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumTokensToInit: 10_000,
  minimumTokensBetweenUpdates: 5_000,
  toolCallsBetweenUpdates: 3,
  extractMaxTokens: 2_400,
  extractionWaitTimeoutMs: 15_000,
  extractionStaleAfterMs: 60_000,
  extractionPollIntervalMs: 1_000,
  maxUpdateMessages: 40,
  maxMessageChars: 1_200,
};

export const createSessionMemoryRecord = (
  overrides?: Partial<SessionMemoryRecord>,
): SessionMemoryRecord => ({
  template: DEFAULT_SESSION_MEMORY_TEMPLATE,
  notes: DEFAULT_SESSION_MEMORY_TEMPLATE,
  initialized: false,
  tokensAtLastExtraction: 0,
  ...overrides,
});

export const mergeSessionMemoryConfig = (
  overrides?: Partial<SessionMemoryConfig>,
): SessionMemoryConfig => ({
  ...DEFAULT_SESSION_MEMORY_CONFIG,
  ...overrides,
});

export const applySessionMemoryRecordToState = (
  state: AgentState,
  record: SessionMemoryRecord,
): AgentState => {
  const baseContext = state.context ?? {
    roundIndex: 0,
    lastLayerExecutions: [],
    consecutiveCompactFailures: 0,
    promptTooLongRetries: 0,
    toolResultCache: {},
    preservedContextAssets: {},
    preservedSegments: {},
    compactBoundaries: [],
    compactionDiagnostics: [],
  };

  return {
    ...state,
    context: {
      ...baseContext,
      sessionMemoryState: {
        ...baseContext.sessionMemoryState,
        template: record.template,
        notes: record.notes,
        initialized: record.initialized,
        tokensAtLastExtraction: record.tokensAtLastExtraction,
        ...(record.summarySourceRound !== undefined
          ? { summarySourceRound: record.summarySourceRound }
          : {}),
        ...(record.lastExtractionMessageId
          ? { lastExtractionMessageId: record.lastExtractionMessageId }
          : {}),
        ...(record.lastSummarizedMessageId
          ? { lastSummarizedMessageId: record.lastSummarizedMessageId }
          : {}),
        ...(record.lastExtractedAt ? { lastExtractedAt: record.lastExtractedAt } : {}),
        ...(record.extractionStartedAt ? { extractionStartedAt: record.extractionStartedAt } : {}),
      },
    },
  };
};

export const sessionMemoryRecordFromState = (state: AgentState): SessionMemoryRecord | null => {
  const sessionMemoryState = state.context?.sessionMemoryState;
  if (!sessionMemoryState?.notes) return null;

  return createSessionMemoryRecord({
    template: sessionMemoryState.template ?? DEFAULT_SESSION_MEMORY_TEMPLATE,
    notes: sessionMemoryState.notes,
    initialized: sessionMemoryState.initialized ?? false,
    tokensAtLastExtraction: sessionMemoryState.tokensAtLastExtraction ?? 0,
    ...(sessionMemoryState.summarySourceRound !== undefined
      ? { summarySourceRound: sessionMemoryState.summarySourceRound }
      : {}),
    ...(sessionMemoryState.lastExtractionMessageId
      ? { lastExtractionMessageId: sessionMemoryState.lastExtractionMessageId }
      : {}),
    ...(sessionMemoryState.lastSummarizedMessageId
      ? { lastSummarizedMessageId: sessionMemoryState.lastSummarizedMessageId }
      : {}),
    ...(sessionMemoryState.lastExtractedAt
      ? { lastExtractedAt: sessionMemoryState.lastExtractedAt }
      : {}),
    ...(sessionMemoryState.extractionStartedAt
      ? { extractionStartedAt: sessionMemoryState.extractionStartedAt }
      : {}),
  });
};

export const isSessionMemoryEmpty = (
  notes: string,
  template = DEFAULT_SESSION_MEMORY_TEMPLATE,
): boolean => notes.trim() === template.trim();

export const buildSessionMemoryUpdatePrompt = (input: SessionMemoryPromptInput): string => {
  const conversation = serializeConversation(input.conversation);
  const sizeReminders = buildSectionSizeReminders(input.currentNotes);

  return `IMPORTANT: This message is not part of the user conversation. Do not mention note-taking, session-memory extraction, or these instructions in the notes.

Rewrite the session memory notes file using only information from the conversation transcript below.

Notes file path:
${input.notesPath}

Current notes content:
<current_notes_content>
${input.currentNotes}
</current_notes_content>

Recent conversation transcript:
<conversation_transcript>
${conversation}
</conversation_transcript>

Your ONLY task is to rewrite the notes file content as a complete markdown document, then stop.

Rules:
- Keep the same overall template structure.
- Do NOT change, remove, or reorder any section headers.
- Do NOT change or remove the italic instruction line directly below each section header.
- ONLY replace or fill in the content underneath each section.
- Do not add any extra sections outside the template.
- Leave sections blank if there is no substantive information.
- Keep the notes highly specific: include file paths, commands, error messages, boundaries, pending work, and user corrections.
- Always refresh "Current State" and "Worklog" to reflect the newest conversation state.
- Prefer compact, information-dense writing over filler.
- Return only the full rewritten markdown for the notes file.
${sizeReminders}`;
};

export const truncateSessionMemoryForCompact = (
  content: string,
): {
  truncatedContent: string;
  wasTruncated: boolean;
} => {
  const lines = content.split("\n");
  const maxCharsPerSection = MAX_SECTION_TOKENS * 4;
  const outputLines: string[] = [];
  let currentHeader = "";
  let currentLines: string[] = [];
  let wasTruncated = false;

  const flush = (): void => {
    if (!currentHeader) {
      outputLines.push(...currentLines);
      currentLines = [];
      return;
    }

    const sectionContent = currentLines.join("\n");
    if (sectionContent.length <= maxCharsPerSection) {
      outputLines.push(currentHeader, ...currentLines);
      currentLines = [];
      return;
    }

    wasTruncated = true;
    let charCount = 0;
    outputLines.push(currentHeader);
    for (const line of currentLines) {
      if (charCount + line.length + 1 > maxCharsPerSection) break;
      outputLines.push(line);
      charCount += line.length + 1;
    }
    outputLines.push("[... section truncated for length ...]");
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("# ")) {
      flush();
      currentHeader = line;
      continue;
    }
    currentLines.push(line);
  }
  flush();

  return {
    truncatedContent: outputLines.join("\n"),
    wasTruncated,
  };
};

export const waitForSessionMemoryIdle = async (input: {
  loadRecord: () => Promise<SessionMemoryRecord>;
  timeoutMs: number;
  staleAfterMs: number;
  pollIntervalMs: number;
}): Promise<SessionMemoryRecord> => {
  const startedAt = Date.now();
  while (true) {
    const record = await input.loadRecord();
    if (!record.extractionStartedAt) return record;

    const extractionAge = Date.now() - Date.parse(record.extractionStartedAt);
    if (!Number.isFinite(extractionAge) || extractionAge > input.staleAfterMs) {
      return record;
    }
    if (Date.now() - startedAt > input.timeoutMs) {
      return record;
    }
    await sleep(input.pollIntervalMs);
  }
};

export const evaluateSessionMemoryExtraction = (input: {
  messages: RunMessage[];
  state: SessionMemoryRecord;
  config?: Partial<SessionMemoryConfig>;
}): {
  shouldExtract: boolean;
  currentTokenCount: number;
  nextState: SessionMemoryRecord;
} => {
  const config = mergeSessionMemoryConfig(input.config);
  const currentTokenCount = estimateMessagesTokens(input.messages);
  let nextState = createSessionMemoryRecord({
    ...input.state,
  });

  if (!nextState.initialized) {
    if (currentTokenCount < config.minimumTokensToInit) {
      return { shouldExtract: false, currentTokenCount, nextState };
    }
    nextState = {
      ...nextState,
      initialized: true,
    };
  }

  const hasMetTokenThreshold =
    currentTokenCount - nextState.tokensAtLastExtraction >= config.minimumTokensBetweenUpdates;
  const toolCallsSinceLastExtraction = countToolCallsSince(
    input.messages,
    nextState.lastExtractionMessageId,
  );
  const hasMetToolCallThreshold = toolCallsSinceLastExtraction >= config.toolCallsBetweenUpdates;
  const hasToolCallsInLatestAssistantTurn = hasToolCallsInLastAssistantTurn(input.messages);

  const shouldExtract =
    (hasMetTokenThreshold && hasMetToolCallThreshold) ||
    (hasMetTokenThreshold && !hasToolCallsInLatestAssistantTurn);
  if (!shouldExtract) {
    return { shouldExtract: false, currentTokenCount, nextState };
  }

  const lastMessageId = input.messages[input.messages.length - 1]?.id;
  return {
    shouldExtract: true,
    currentTokenCount,
    nextState: {
      ...nextState,
      ...(lastMessageId ? { lastExtractionMessageId: lastMessageId } : {}),
    },
  };
};

export const buildSessionMemoryConversationWindow = (
  messages: RunMessage[],
  config?: Partial<SessionMemoryConfig>,
  lastSummarizedMessageId?: string,
): RunMessage[] => {
  const resolved = mergeSessionMemoryConfig(config);
  let startIndex = 0;
  if (lastSummarizedMessageId) {
    const foundIndex = messages.findIndex(
      (message) =>
        message.id === lastSummarizedMessageId || message.messageId === lastSummarizedMessageId,
    );
    if (foundIndex >= 0) {
      startIndex = foundIndex + 1;
    }
  }

  const selected = messages.slice(startIndex).slice(-resolved.maxUpdateMessages);
  const trimmed: RunMessage[] = [];
  for (const message of selected) {
    trimmed.push({
      ...message,
      content:
        message.content.length > resolved.maxMessageChars
          ? `${message.content.slice(0, resolved.maxMessageChars)}\n...[truncated]`
          : message.content,
    });
  }
  return trimmed;
};

export const canAdvanceLastSummarizedMessage = (messages: RunMessage[]): boolean =>
  !hasToolCallsInLastAssistantTurn(messages);

export class ModelSessionMemoryExtractor implements SessionMemoryExtractor {
  constructor(
    private readonly modelClient: ModelClient,
    private readonly model: string,
  ) {}

  async extract(input: {
    runId: string;
    notesPath: string;
    record: SessionMemoryRecord;
    conversation: RunMessage[];
    prompt: string;
    config: SessionMemoryConfig;
    signal?: AbortSignal;
  }): Promise<{ notes: string }> {
    const request: ModelRequest = {
      model: this.model,
      systemPrompt:
        "You maintain a persistent markdown session memory for an AI coding agent. Rewrite the notes faithfully and preserve the template structure.",
      messages: [
        {
          id: `session_memory_${Date.now()}`,
          role: "user",
          content: input.prompt,
          createdAt: new Date().toISOString(),
        },
      ],
      tools: [],
      metadata: {
        sessionMemoryExtraction: true,
      },
      maxTokens: input.config.extractMaxTokens,
      ...(input.signal ? { signal: input.signal } : {}),
    };
    const response = await this.modelClient.generate(request);
    if (response.type !== "final") {
      throw new Error("Session memory extraction returned non-final response");
    }
    return {
      notes: response.output.trim(),
    };
  }
}

export class SessionMemoryService {
  private static readonly deferredTasks = new Map<string, Promise<void>>();

  constructor(
    private readonly subsystem: SessionMemorySubsystem,
    private readonly fallbackExtractor?: SessionMemoryExtractor,
  ) {}

  static resetDeferredTasks(): void {
    this.deferredTasks.clear();
  }

  getConfig(): SessionMemoryConfig {
    return mergeSessionMemoryConfig(this.subsystem.config);
  }

  async ensureRecord(runId: string): Promise<SessionMemoryRecord> {
    const existing = await this.subsystem.store.load(runId);
    if (existing) return existing;

    const record = createSessionMemoryRecord({
      template: this.subsystem.template ?? DEFAULT_SESSION_MEMORY_TEMPLATE,
      notes: this.subsystem.template ?? DEFAULT_SESSION_MEMORY_TEMPLATE,
    });
    await this.subsystem.store.save(runId, record);
    await this.emit("session_memory_initialized", runId, {
      templateLength: record.template.length,
    });
    return record;
  }

  async waitForIdle(runId: string): Promise<SessionMemoryRecord> {
    const config = this.getConfig();
    return await waitForSessionMemoryIdle({
      loadRecord: async () =>
        (await this.subsystem.store.load(runId)) ?? (await this.ensureRecord(runId)),
      timeoutMs: config.extractionWaitTimeoutMs,
      staleAfterMs: config.extractionStaleAfterMs,
      pollIntervalMs: config.extractionPollIntervalMs,
    });
  }

  async hydrateState(
    runId: string,
    state: AgentState,
    options?: { waitForPendingExtraction?: boolean },
  ): Promise<AgentState> {
    let record = await this.ensureRecord(runId);
    if (options?.waitForPendingExtraction) {
      record = await this.waitForIdle(runId);
    }
    return applySessionMemoryRecordToState(state, record);
  }

  async maybeExtract(input: {
    runId: string;
    messages: RunMessage[];
    record: SessionMemoryRecord;
    querySource?: string;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<{ record: SessionMemoryRecord; extracted: boolean }> {
    const isMainThread =
      input.querySource === undefined ||
      input.querySource === "sdk" ||
      input.querySource.startsWith("repl_main_thread");
    if (!isMainThread) {
      await this.emit("session_memory_extraction_skipped", input.runId, {
        reason: "non_main_thread",
      });
      return { record: input.record, extracted: false };
    }

    const evaluation = input.force
      ? {
          shouldExtract: true,
          currentTokenCount: estimateMessagesTokens(input.messages),
          nextState: input.record,
        }
      : evaluateSessionMemoryExtraction({
          messages: input.messages,
          state: input.record,
          ...(this.subsystem.config ? { config: this.subsystem.config } : {}),
        });
    if (!evaluation.shouldExtract) {
      const nextRecord =
        evaluation.nextState.initialized !== input.record.initialized
          ? createSessionMemoryRecord({
              ...evaluation.nextState,
              template: input.record.template,
              notes: input.record.notes,
            })
          : input.record;
      if (nextRecord !== input.record) {
        await this.subsystem.store.save(input.runId, nextRecord);
      }
      await this.emit("session_memory_extraction_skipped", input.runId, {
        reason: "threshold_not_met",
        currentTokenCount: evaluation.currentTokenCount,
      });
      return { record: nextRecord, extracted: false };
    }

    if ((this.subsystem.mode ?? "sync") === "deferred" && !input.force) {
      const startedRecord = await this.markExtractionStarted(
        input.runId,
        evaluation.nextState,
        input.record,
      );
      const task = this.performExtraction({
        ...input,
        record: startedRecord,
        currentTokenCount: evaluation.currentTokenCount,
      }).finally(() => {
        SessionMemoryService.deferredTasks.delete(input.runId);
      });
      SessionMemoryService.deferredTasks.set(
        input.runId,
        task.then(
          () => undefined,
          () => undefined,
        ),
      );
      return { record: startedRecord, extracted: true };
    }

    const finalRecord = await this.performExtraction({
      ...input,
      record: evaluation.nextState,
      currentTokenCount: evaluation.currentTokenCount,
    });
    return { record: finalRecord, extracted: true };
  }

  async extractNow(input: {
    runId: string;
    messages: RunMessage[];
    record: SessionMemoryRecord;
    signal?: AbortSignal;
  }): Promise<SessionMemoryRecord> {
    const result = await this.maybeExtract({
      ...input,
      force: true,
      querySource: "sdk",
    });
    if ((this.subsystem.mode ?? "sync") === "deferred") {
      return await this.waitForIdle(input.runId);
    }
    return result.record;
  }

  private async markExtractionStarted(
    runId: string,
    nextState: SessionMemoryRecord,
    currentRecord: SessionMemoryRecord,
  ): Promise<SessionMemoryRecord> {
    const startedRecord = createSessionMemoryRecord({
      ...currentRecord,
      ...nextState,
      template: currentRecord.template,
      notes: currentRecord.notes,
      extractionStartedAt: new Date().toISOString(),
    });
    await this.subsystem.store.save(runId, startedRecord);
    await this.emit("session_memory_extraction_started", runId, {
      lastExtractionMessageId: startedRecord.lastExtractionMessageId,
    });
    return startedRecord;
  }

  private async performExtraction(input: {
    runId: string;
    messages: RunMessage[];
    record: SessionMemoryRecord;
    currentTokenCount: number;
    signal?: AbortSignal;
  }): Promise<SessionMemoryRecord> {
    const startedRecord = await this.markExtractionStarted(input.runId, input.record, input.record);
    const config = this.getConfig();
    const extractor = this.subsystem.extractor ?? this.fallbackExtractor;
    if (!extractor) {
      throw new Error("SessionMemoryExtractor is required");
    }
    const conversation = buildSessionMemoryConversationWindow(
      input.messages,
      config,
      startedRecord.lastSummarizedMessageId,
    );
    const promptInput: SessionMemoryPromptInput = {
      notesPath: `session-memory/${input.runId}/notes.md`,
      currentNotes: startedRecord.notes,
      conversation,
      record: startedRecord,
      config,
    };
    const prompt = this.subsystem.promptBuilder
      ? this.subsystem.promptBuilder(promptInput)
      : buildSessionMemoryUpdatePrompt(promptInput);

    try {
      const result = await extractor.extract({
        runId: input.runId,
        notesPath: promptInput.notesPath,
        record: startedRecord,
        conversation,
        prompt,
        config,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const finalRecord = createSessionMemoryRecord({
        ...startedRecord,
        template: startedRecord.template,
        notes: result.notes,
        tokensAtLastExtraction: input.currentTokenCount,
        lastExtractedAt: new Date().toISOString(),
        ...(canAdvanceLastSummarizedMessage(input.messages)
          ? {
              lastSummarizedMessageId:
                input.messages[input.messages.length - 1]?.id ??
                startedRecord.lastSummarizedMessageId,
            }
          : {}),
      });
      delete finalRecord.extractionStartedAt;
      await this.subsystem.store.save(input.runId, finalRecord);
      await this.emit("session_memory_extraction_completed", input.runId, {
        notesLength: finalRecord.notes.length,
      });
      return finalRecord;
    } catch (error) {
      const failedRecord = createSessionMemoryRecord({
        ...startedRecord,
      });
      delete failedRecord.extractionStartedAt;
      await this.subsystem.store.save(input.runId, failedRecord);
      await this.emit("session_memory_extraction_failed", input.runId, {
        message: error instanceof Error ? error.message : "unknown_error",
      });
      return failedRecord;
    }
  }

  private async emit(
    type: SessionMemoryEvent["type"],
    runId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.subsystem.hooks?.onEvent({
      type,
      runId,
      timestamp: new Date().toISOString(),
      payload,
    });
  }
}

const buildSectionSizeReminders = (notes: string): string => {
  const sections = analyzeSectionSizes(notes);
  const totalTokens = estimateTextTokens(notes);
  const oversizedSections = Object.entries(sections)
    .filter(([, tokenCount]) => tokenCount > MAX_SECTION_TOKENS)
    .sort(([, left], [, right]) => right - left)
    .map(
      ([section, tokenCount]) =>
        `- "${section}" is approximately ${tokenCount} tokens and should be condensed.`,
    );
  const reminders: string[] = [];

  if (totalTokens > MAX_TOTAL_SESSION_MEMORY_TOKENS) {
    reminders.push(
      `The session memory file is currently approximately ${totalTokens} tokens, so you must condense the file to fit within this budget of ${MAX_TOTAL_SESSION_MEMORY_TOKENS} tokens.`,
    );
  }
  if (oversizedSections.length > 0) {
    reminders.push(`Sections to condense if possible:\n${oversizedSections.join("\n")}`);
  }
  if (reminders.length === 0) return "";
  return `\n\n${reminders.join("\n\n")}`;
};

const analyzeSectionSizes = (notes: string): Record<string, number> => {
  const sections: Record<string, number> = {};
  const lines = notes.split("\n");
  let currentSection = "";
  let currentLines: string[] = [];

  const flush = (): void => {
    if (!currentSection) return;
    sections[currentSection] = estimateTextTokens(currentLines.join("\n").trim());
  };

  for (const line of lines) {
    if (line.startsWith("# ")) {
      flush();
      currentSection = line;
      currentLines = [];
      continue;
    }
    currentLines.push(line);
  }
  flush();
  return sections;
};

const serializeConversation = (messages: RunMessage[]): string =>
  messages
    .map((message) => {
      const role = message.role === "tool" ? `tool:${message.name ?? "unknown"}` : message.role;
      const toolCalls =
        message.toolCalls && message.toolCalls.length > 0
          ? `\nTool calls: ${JSON.stringify(message.toolCalls)}`
          : "";
      return `${role}\n${message.content}${toolCalls}`;
    })
    .join("\n\n");

const countToolCallsSince = (messages: RunMessage[], sinceMessageId?: string): number => {
  let foundStart = sinceMessageId === undefined;
  let count = 0;
  for (const message of messages) {
    if (!foundStart) {
      if (message.id === sinceMessageId || message.messageId === sinceMessageId) {
        foundStart = true;
      }
      continue;
    }
    count += message.toolCalls?.length ?? 0;
  }
  return count;
};

const hasToolCallsInLastAssistantTurn = (messages: RunMessage[]): boolean => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role !== "assistant") continue;
    return (message.toolCalls?.length ?? 0) > 0;
  }
  return false;
};

const estimateMessagesTokens = (messages: RunMessage[]): number =>
  messages.reduce((total, message) => {
    const toolCallTokens = JSON.stringify(message.toolCalls ?? []).length;
    return total + estimateTextTokens(message.content) + Math.ceil(toolCallTokens / 4);
  }, 0);

const estimateTextTokens = (value: string): number => Math.max(1, Math.ceil(value.length / 4));

const sleep = async (ms: number): Promise<void> => {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};
