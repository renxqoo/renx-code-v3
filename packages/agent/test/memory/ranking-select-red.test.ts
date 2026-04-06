import { describe, expect, it, vi } from "vitest";

import type { ModelClient, ModelResponse } from "@renx/model";

import {
  selectRelevantMemories,
  SELECT_MEMORIES_SYSTEM_PROMPT,
} from "../../src/memory/ranking/select";
import type { MemoryFileHeader } from "../../src/memory/memdir/scanner";

function mockModelClient(response: ModelResponse): ModelClient {
  return {
    generate: vi.fn().mockResolvedValue(response),
    stream: vi.fn(),
    resolve: vi.fn().mockReturnValue({ provider: "test", model: "test-model" }),
  };
}

const finalResponse = (text: string): ModelResponse => ({
  type: "final",
  output: text,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
});

function makeHeader(overrides: Partial<MemoryFileHeader> = {}): MemoryFileHeader {
  return {
    filename: "test.md",
    filePath: "/mem/test.md",
    mtimeMs: Date.now(),
    description: "Test memory",
    type: "user",
    ...overrides,
  };
}

describe("selectRelevantMemories", () => {
  const signal = new AbortController().signal;

  it("returns filenames selected by model", async () => {
    const client = mockModelClient(
      finalResponse(JSON.stringify({ selected_memories: ["role.md", "feedback.md"] })),
    );
    const headers = [
      makeHeader({ filename: "role.md", description: "User role" }),
      makeHeader({ filename: "feedback.md", description: "Feedback" }),
      makeHeader({ filename: "other.md", description: "Other" }),
    ];

    const selected = await selectRelevantMemories(
      client,
      "test-model",
      "what is my role?",
      headers,
      signal,
    );
    expect(selected).toEqual(["role.md", "feedback.md"]);
  });

  it("filters out filenames not in the valid set", async () => {
    const client = mockModelClient(
      finalResponse(JSON.stringify({ selected_memories: ["role.md", "nonexistent.md"] })),
    );
    const headers = [makeHeader({ filename: "role.md" })];

    const selected = await selectRelevantMemories(client, "test-model", "query", headers, signal);
    expect(selected).toEqual(["role.md"]);
  });

  it("returns empty array when model returns no text", async () => {
    const client = mockModelClient(finalResponse(""));
    const headers = [makeHeader({ filename: "role.md" })];

    const selected = await selectRelevantMemories(client, "test-model", "query", headers, signal);
    expect(selected).toEqual([]);
  });

  it("returns empty array on model error", async () => {
    const client: ModelClient = {
      generate: vi.fn().mockRejectedValue(new Error("API error")),
      stream: vi.fn(),
      resolve: vi.fn(),
    };
    const headers = [makeHeader({ filename: "role.md" })];

    const selected = await selectRelevantMemories(client, "test-model", "query", headers, signal);
    expect(selected).toEqual([]);
  });

  it("passes recent tools to model in the prompt", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue(finalResponse(JSON.stringify({ selected_memories: [] })));
    const client: ModelClient = {
      generate,
      stream: vi.fn(),
      resolve: vi.fn(),
    };
    const headers = [makeHeader({ filename: "role.md" })];

    await selectRelevantMemories(client, "test-model", "query", headers, signal, ["Read", "Grep"]);

    const call = generate.mock.calls[0]![0];
    expect(call.messages[0]!.content).toContain("Recently used tools: Read, Grep");
  });

  it("does not include recent tools section when empty", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue(finalResponse(JSON.stringify({ selected_memories: [] })));
    const client: ModelClient = {
      generate,
      stream: vi.fn(),
      resolve: vi.fn(),
    };
    const headers = [makeHeader({ filename: "role.md" })];

    await selectRelevantMemories(client, "test-model", "query", headers, signal);

    const call = generate.mock.calls[0]![0];
    expect(call.messages[0]!.content).not.toContain("Recently used tools");
  });
});

describe("SELECT_MEMORIES_SYSTEM_PROMPT", () => {
  it("instructs to select up to 5 memories", () => {
    expect(SELECT_MEMORIES_SYSTEM_PROMPT).toContain("up to 5");
  });

  it("instructs to filter recently-used tools docs", () => {
    expect(SELECT_MEMORIES_SYSTEM_PROMPT).toContain("recently-used tools");
  });

  it("instructs to be selective and discerning", () => {
    expect(SELECT_MEMORIES_SYSTEM_PROMPT).toContain("selective and discerning");
  });
});
