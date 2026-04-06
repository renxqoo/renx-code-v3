import { describe, expect, it } from "vitest";

import type { AgentRunContext, ToolContext } from "@renx/agent";
import { LocalBackend } from "@renx/agent";
import type { ToolCall } from "@renx/model";

import { createSyntheticOutputTool } from "../src/index";

const createToolContext = (): ToolContext => {
  const runContext: AgentRunContext = {
    input: {
      messages: [
        {
          id: "msg_structured_1",
          messageId: "msg_structured_1",
          role: "user",
          content: "structured output test",
          createdAt: new Date().toISOString(),
          source: "input",
        },
      ],
    },
    identity: { userId: "u1", tenantId: "t1", roles: ["developer"] },
    state: {
      runId: "run_1",
      messages: [],
      scratchpad: {},
      memory: {},
      stepCount: 0,
      status: "running",
    },
    services: {},
    metadata: {},
  };
  const toolCall: ToolCall = { id: "tc_1", name: "StructuredOutput", input: {} };
  return { runContext, toolCall, backend: new LocalBackend() };
};

describe("StructuredOutput", () => {
  it("returns an error when the provided JSON schema is invalid", () => {
    const result = createSyntheticOutputTool({
      type: "object",
      properties: {
        bugs: [] as unknown as Record<string, unknown>,
      },
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/must be object|should be object|invalid/i);
    }
  });

  it("caches tool creation by JSON schema object identity", () => {
    const jsonSchema = {
      type: "object",
      properties: {
        verdict: { type: "string" },
      },
      required: ["verdict"],
      additionalProperties: false,
    } satisfies Record<string, unknown>;

    const first = createSyntheticOutputTool(jsonSchema);
    const second = createSyntheticOutputTool(jsonSchema);

    expect(first).toBe(second);
  });

  it("validates runtime input against the provided dynamic schema", async () => {
    const result = createSyntheticOutputTool({
      type: "object",
      properties: {
        verdict: { type: "string" },
        score: { type: "integer" },
      },
      required: ["verdict", "score"],
      additionalProperties: false,
    });

    if ("error" in result) {
      throw new Error(result.error);
    }

    const ctx = createToolContext();
    const success = await result.tool.invoke({ verdict: "pass", score: 100 }, ctx);
    expect(success.content).toContain("Structured output provided successfully");
    expect(success.structured).toEqual({ verdict: "pass", score: 100 });

    await expect(result.tool.invoke({ verdict: "pass", score: "100" }, ctx)).rejects.toThrow(
      /Output does not match required schema/i,
    );
  });
});
