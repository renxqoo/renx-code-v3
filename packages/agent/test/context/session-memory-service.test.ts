import { afterEach, describe, expect, it } from "vitest";

import type {
  SessionMemoryEvent,
  SessionMemoryExtractor,
  SessionMemoryRecord,
  SessionMemorySubsystem,
} from "../../src/types";
import type { RunMessage } from "../../src/message/types";
import {
  DEFAULT_SESSION_MEMORY_TEMPLATE,
  SessionMemoryService,
  createSessionMemoryRecord,
} from "../../src/context/session-memory";
import { InMemorySessionMemoryStore } from "../../src/context/session-memory-store";

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

describe("SessionMemoryService", () => {
  afterEach(() => {
    SessionMemoryService.resetDeferredTasks();
  });

  it("uses custom template and custom prompt builder with a pluggable extractor", async () => {
    const prompts: string[] = [];
    const extractor: SessionMemoryExtractor = {
      extract: async (input) => {
        prompts.push(input.prompt);
        return {
          notes: `${input.record.template}\nFilled by custom extractor.`,
        };
      },
    };
    const subsystem: SessionMemorySubsystem = {
      store: new InMemorySessionMemoryStore(),
      extractor,
      template: "# Team Memory\n_Keep this exact header line_",
      promptBuilder: ({ notesPath }) => `CUSTOM PROMPT FOR ${notesPath}`,
      config: {
        minimumTokensToInit: 1,
        minimumTokensBetweenUpdates: 1,
        toolCallsBetweenUpdates: 99,
      },
    };
    const service = new SessionMemoryService(subsystem);

    const record = await service.ensureRecord("run_custom");
    const extracted = await service.extractNow({
      runId: "run_custom",
      messages: [createMessage("m_1", "user", "Capture this custom workflow context.")],
      record,
    });

    expect(record.template).toBe("# Team Memory\n_Keep this exact header line_");
    expect(prompts[0]).toContain("CUSTOM PROMPT FOR session-memory/run_custom/notes.md");
    expect(extracted.notes).toContain("Filled by custom extractor.");
  });

  it("emits lifecycle hooks for skipped and completed extraction", async () => {
    const events: SessionMemoryEvent[] = [];
    const subsystem: SessionMemorySubsystem = {
      store: new InMemorySessionMemoryStore(),
      extractor: {
        extract: async ({ record }) => ({
          notes: `${record.template}\nUpdated from hook test.`,
        }),
      },
      hooks: {
        onEvent: (event) => {
          events.push(event);
        },
      },
      config: {
        minimumTokensToInit: 50,
        minimumTokensBetweenUpdates: 20,
        toolCallsBetweenUpdates: 99,
      },
    };
    const service = new SessionMemoryService(subsystem);
    const record = await service.ensureRecord("run_hooks");

    const skipped = await service.maybeExtract({
      runId: "run_hooks",
      messages: [createMessage("m_1", "user", "short")],
      record,
    });
    const completed = await service.extractNow({
      runId: "run_hooks",
      messages: [createMessage("m_2", "user", "x".repeat(200))],
      record: skipped.record,
    });

    expect(skipped.extracted).toBe(false);
    expect(completed.notes).toContain("Updated from hook test.");
    expect(events.map((event) => event.type)).toContain("session_memory_extraction_skipped");
    expect(events.map((event) => event.type)).toContain("session_memory_extraction_started");
    expect(events.map((event) => event.type)).toContain("session_memory_extraction_completed");
  });

  it("supports deferred extraction mode without waiting for extractor completion", async () => {
    let resolveExtraction: ((record: SessionMemoryRecord) => void) | undefined;
    const extractor: SessionMemoryExtractor = {
      extract: async ({ record }) =>
        await new Promise<{ notes: string }>((resolve) => {
          resolveExtraction = () =>
            resolve({
              notes: `${record.template}\nDeferred extraction finished.`,
            });
        }),
    };
    const store = new InMemorySessionMemoryStore();
    const subsystem: SessionMemorySubsystem = {
      store,
      extractor,
      mode: "deferred",
      config: {
        minimumTokensToInit: 1,
        minimumTokensBetweenUpdates: 1,
        toolCallsBetweenUpdates: 99,
      },
    };
    const service = new SessionMemoryService(subsystem);
    const record = await service.ensureRecord("run_deferred");

    const started = await service.maybeExtract({
      runId: "run_deferred",
      messages: [createMessage("m_1", "user", "x".repeat(200))],
      record,
    });

    expect(started.extracted).toBe(true);
    expect(started.record.extractionStartedAt).toBeDefined();
    const beforeFinish = await store.load("run_deferred");
    expect(beforeFinish?.notes).toBe(DEFAULT_SESSION_MEMORY_TEMPLATE);

    for (let attempt = 0; attempt < 20 && !resolveExtraction; attempt += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    expect(resolveExtraction).toBeTypeOf("function");
    resolveExtraction?.(started.record);
    const settled = await service.waitForIdle("run_deferred");

    expect(settled.extractionStartedAt).toBeUndefined();
    expect(settled.notes).toContain("Deferred extraction finished.");
  });
});
