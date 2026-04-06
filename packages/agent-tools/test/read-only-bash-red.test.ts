import { describe, expect, it } from "vitest";

import type { AgentRunContext, ToolContext } from "@renx/agent";
import type { ToolCall } from "@renx/model";

import { createReadOnlyBashTool } from "../src";

function minimalCtx(backend: ToolContext["backend"]): ToolContext {
  const runContext: AgentRunContext = {
    input: { messages: [] },
    identity: { userId: "u", tenantId: "t", roles: [] },
    state: {
      runId: "r",
      messages: [],
      scratchpad: {},
      memory: {},
      stepCount: 0,
      status: "running",
    },
    services: {},
    metadata: {},
  };
  const toolCall: ToolCall = {
    id: "c1",
    name: "Bash",
    input: {},
  };
  return { runContext, toolCall, backend };
}

describe("createReadOnlyBashTool", () => {
  it("blocks mutating shell commands before execution", async () => {
    let invoked = false;
    const backend = {
      kind: "test",
      capabilities: () => ({
        exec: true,
        filesystemRead: false,
        filesystemWrite: false,
      }),
      exec: async () => {
        invoked = true;
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
      },
    };

    const tool = createReadOnlyBashTool();
    const result = await tool.invoke(
      { command: "touch should-not-exist.txt" },
      minimalCtx(backend),
    );

    expect(invoked).toBe(false);
    expect(result.metadata).toMatchObject({ blocked: true, code: "PREFIX_DENY" });
    expect(result.content).toContain("allowed-prefix");
  });
});
