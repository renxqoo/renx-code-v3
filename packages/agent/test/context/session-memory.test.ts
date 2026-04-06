import { describe, expect, it } from "vitest";

import type { RunMessage } from "../../src/message/types";
import type { SessionMemoryRecord } from "../../src/types";
import {
  DEFAULT_SESSION_MEMORY_CONFIG,
  DEFAULT_SESSION_MEMORY_TEMPLATE,
  buildSessionMemoryUpdatePrompt,
  createSessionMemoryRecord,
  evaluateSessionMemoryExtraction,
  isSessionMemoryEmpty,
  truncateSessionMemoryForCompact,
  waitForSessionMemoryIdle,
} from "../../src/context/session-memory";

const createMessage = (
  id: string,
  role: RunMessage["role"],
  content: string,
  extra?: Partial<RunMessage>,
): RunMessage => ({
  id,
  messageId: `${id}_msg`,
  role,
  content,
  createdAt: new Date(
    1_700_000_000_000 + Number.parseInt(id.replace(/\D/g, "") || "0", 10),
  ).toISOString(),
  source: role === "tool" ? "tool" : role === "assistant" ? "model" : "input",
  ...extra,
});

describe("session memory", () => {
  it("creates a new record with the default template and empty extraction state", () => {
    const record = createSessionMemoryRecord();

    expect(record.notes).toContain("# Session Title");
    expect(record.notes).toBe(DEFAULT_SESSION_MEMORY_TEMPLATE);
    expect(record.initialized).toBe(false);
    expect(record.tokensAtLastExtraction).toBe(0);
    expect(record.lastSummarizedMessageId).toBeUndefined();
  });

  it("builds an update prompt that preserves template structure and embeds recent conversation", () => {
    const prompt = buildSessionMemoryUpdatePrompt({
      notesPath: "D:/tmp/session-memory/run-1/notes.md",
      currentNotes: DEFAULT_SESSION_MEMORY_TEMPLATE,
      conversation: [
        createMessage("m_1", "user", "Please fix the context compression bug."),
        createMessage("m_2", "assistant", "I will inspect the compaction pipeline."),
      ],
      record: createSessionMemoryRecord(),
      config: DEFAULT_SESSION_MEMORY_CONFIG,
    });

    expect(prompt).toContain("ONLY task is to rewrite the notes file");
    expect(prompt).toContain("Do NOT change, remove, or reorder any section headers");
    expect(prompt).toContain("D:/tmp/session-memory/run-1/notes.md");
    expect(prompt).toContain("Please fix the context compression bug.");
    expect(prompt).toContain("I will inspect the compaction pipeline.");
  });

  it("adds total-budget reminders when notes are globally oversized", () => {
    const hugeNotes = `${DEFAULT_SESSION_MEMORY_TEMPLATE}\n${"B".repeat(60_000)}`;

    const prompt = buildSessionMemoryUpdatePrompt({
      notesPath: "D:/tmp/session-memory/run-2/notes.md",
      currentNotes: hugeNotes,
      conversation: [createMessage("m_1", "user", "Condense the memory file.")],
      record: createSessionMemoryRecord(),
      config: DEFAULT_SESSION_MEMORY_CONFIG,
    });

    expect(prompt).toContain("session memory file is currently");
    expect(prompt).toContain("must condense the file to fit within this budget");
  });

  it("detects whether notes are still just the empty template", () => {
    expect(isSessionMemoryEmpty(DEFAULT_SESSION_MEMORY_TEMPLATE)).toBe(true);
    expect(
      isSessionMemoryEmpty(
        `${DEFAULT_SESSION_MEMORY_TEMPLATE}\nImplemented extraction boundary handling.`,
      ),
    ).toBe(false);
  });

  it("does not extract before the initialization threshold is reached", () => {
    const decision = evaluateSessionMemoryExtraction({
      messages: [createMessage("m_1", "user", "short message")],
      state: createSessionMemoryRecord(),
      config: {
        ...DEFAULT_SESSION_MEMORY_CONFIG,
        minimumTokensToInit: 200,
        minimumTokensBetweenUpdates: 40,
        toolCallsBetweenUpdates: 2,
      },
    });

    expect(decision.shouldExtract).toBe(false);
    expect(decision.nextState.initialized).toBe(false);
  });

  it("extracts after initialization once enough new tokens accumulate at a natural break", () => {
    const decision = evaluateSessionMemoryExtraction({
      messages: [
        createMessage("m_1", "user", "x".repeat(80)),
        createMessage("m_2", "assistant", "y".repeat(80)),
      ],
      state: createSessionMemoryRecord(),
      config: {
        ...DEFAULT_SESSION_MEMORY_CONFIG,
        minimumTokensToInit: 20,
        minimumTokensBetweenUpdates: 20,
        toolCallsBetweenUpdates: 3,
      },
    });

    expect(decision.shouldExtract).toBe(true);
    expect(decision.nextState.initialized).toBe(true);
    expect(decision.nextState.lastExtractionMessageId).toBe("m_2");
  });

  it("requires the token threshold even when many tool calls happened", () => {
    const decision = evaluateSessionMemoryExtraction({
      messages: [
        createMessage("m_1", "assistant", "tool planning", {
          toolCalls: [
            { id: "tc_1", name: "read", input: { path: "a.ts" } },
            { id: "tc_2", name: "grep", input: { pattern: "todo" } },
          ],
        }),
        createMessage("m_2", "tool", "file content"),
      ],
      state: {
        ...createSessionMemoryRecord(),
        initialized: true,
        tokensAtLastExtraction: 100,
      },
      config: {
        ...DEFAULT_SESSION_MEMORY_CONFIG,
        minimumTokensToInit: 20,
        minimumTokensBetweenUpdates: 80,
        toolCallsBetweenUpdates: 2,
      },
    });

    expect(decision.shouldExtract).toBe(false);
  });

  it("extracts on tool-heavy sessions once both token and tool-call thresholds are met", () => {
    const decision = evaluateSessionMemoryExtraction({
      messages: [
        createMessage("m_1", "assistant", "planning", {
          toolCalls: [
            { id: "tc_1", name: "read", input: { path: "a.ts" } },
            { id: "tc_2", name: "grep", input: { pattern: "todo" } },
          ],
        }),
        createMessage("m_2", "tool", "tool output 1"),
        createMessage("m_3", "assistant", "continue", {
          toolCalls: [{ id: "tc_3", name: "bash", input: { command: "pnpm test" } }],
        }),
        createMessage("m_4", "tool", "tool output 2"),
      ],
      state: {
        ...createSessionMemoryRecord(),
        initialized: true,
        tokensAtLastExtraction: 10,
      },
      config: {
        ...DEFAULT_SESSION_MEMORY_CONFIG,
        minimumTokensToInit: 20,
        minimumTokensBetweenUpdates: 10,
        toolCallsBetweenUpdates: 3,
      },
    });

    expect(decision.shouldExtract).toBe(true);
    expect(decision.nextState.lastExtractionMessageId).toBe("m_4");
  });

  it("truncates oversized sections for compact injection without dropping section headers", () => {
    const result = truncateSessionMemoryForCompact(
      `${DEFAULT_SESSION_MEMORY_TEMPLATE}\n${"A".repeat(12_000)}`,
    );

    expect(result.wasTruncated).toBe(true);
    expect(result.truncatedContent).toContain("# Session Title");
    expect(result.truncatedContent).toContain("[... section truncated for length ...]");
  });

  it("waits for an in-flight extraction to finish before proceeding", async () => {
    let pending: SessionMemoryRecord = {
      ...createSessionMemoryRecord(),
      extractionStartedAt: new Date().toISOString(),
    };

    setTimeout(() => {
      const { extractionStartedAt: _extractionStartedAt, ...rest } = pending;
      pending = {
        ...rest,
        notes: DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
          "_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._",
          "_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nSession memory extraction finished.",
        ),
      };
    }, 10);

    const loaded = await waitForSessionMemoryIdle({
      loadRecord: async () => pending,
      timeoutMs: 250,
      staleAfterMs: 5_000,
      pollIntervalMs: 5,
    });

    expect(loaded.extractionStartedAt).toBeUndefined();
    expect(loaded.notes).toContain("Session memory extraction finished.");
  });

  it("does not wait forever for stale extraction markers", async () => {
    const staleStartedAt = new Date(Date.now() - 120_000).toISOString();
    const loaded = await waitForSessionMemoryIdle({
      loadRecord: async () => ({
        ...createSessionMemoryRecord(),
        extractionStartedAt: staleStartedAt,
      }),
      timeoutMs: 250,
      staleAfterMs: 1_000,
      pollIntervalMs: 5,
    });

    expect(loaded.extractionStartedAt).toBe(staleStartedAt);
  });
});
