import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentRunContext, ExecutionBackend, ToolContext, ToolResult } from "@renx/agent";
import { applyStatePatch } from "@renx/agent";
import type { ToolCall } from "@renx/model";
import { createFileReadTool } from "@renx/agent-tools";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createToolContext(workspaceRoot: string, backend: ExecutionBackend): ToolContext {
  const runContext: AgentRunContext = {
    input: {
      messages: [
        {
          id: "msg_integration_1",
          messageId: "msg_integration_1",
          role: "user",
          content: "test",
          createdAt: new Date().toISOString(),
          source: "input",
        },
      ],
    },
    identity: { userId: "u1", tenantId: "t1", roles: [] },
    state: {
      runId: "run_1",
      messages: [],
      scratchpad: {},
      memory: {},
      stepCount: 0,
      status: "running",
    },
    services: {},
    metadata: { workspaceRoot },
  };
  const toolCall: ToolCall = { id: "tc_1", name: "Read", input: {} };
  return { runContext, toolCall, backend };
}

const applyToolState = (ctx: ToolContext, result: ToolResult): void => {
  ctx.runContext.state = applyStatePatch(ctx.runContext.state, result.statePatch);
};

const normalizePath = (value: string): string => value.replaceAll("\\", "/");

describe("sandbox integration with workspace tools", () => {
  it("reads binary assets through backend primitives instead of host fs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-tool-binary-"));
    tempDirs.push(dir);

    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const observedReads: string[] = [];

    const backend: ExecutionBackend = {
      kind: "sandbox",
      capabilities: () => ({
        exec: false,
        filesystemRead: true,
        filesystemWrite: false,
        network: false,
        binaryRead: true,
        pathMetadata: true,
      }),
      readBinaryFile: async (path) => {
        observedReads.push(normalizePath(path));
        return imageBytes;
      },
    };

    const ctx = createToolContext(dir, backend);
    const result = await createFileReadTool().invoke({ file_path: "assets/logo.png" }, ctx);

    expect(observedReads).toEqual([normalizePath(join(dir, "assets", "logo.png"))]);
    expect(result.structured).toMatchObject({
      path: "assets/logo.png",
      type: "image",
      mediaType: "image/png",
      size: imageBytes.byteLength,
    });
    expect(result.structured).toHaveProperty("base64");
  });

  it("uses backend stat metadata to deduplicate unchanged rereads without directory listing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-tool-stat-"));
    tempDirs.push(dir);

    const filePath = normalizePath(join(dir, "src", "app.ts"));
    const content = "export const value = 1;\n";
    const modifiedAt = "2026-01-01T00:00:00.000Z";

    const backend: ExecutionBackend = {
      kind: "sandbox",
      capabilities: () => ({
        exec: false,
        filesystemRead: true,
        filesystemWrite: false,
        network: false,
        pathMetadata: true,
      }),
      readFile: async (path) => {
        if (normalizePath(path) !== filePath) {
          throw new Error(`Unexpected path: ${path}`);
        }
        return content;
      },
      statPath: async (path) => {
        if (normalizePath(path) !== filePath) {
          return undefined;
        }
        return {
          path,
          isDirectory: false,
          size: Buffer.byteLength(content, "utf8"),
          modifiedAt,
        };
      },
    };

    const ctx = createToolContext(dir, backend);
    const tool = createFileReadTool();

    const first = await tool.invoke({ file_path: "src/app.ts" }, ctx);
    applyToolState(ctx, first);

    const second = await tool.invoke({ file_path: "src/app.ts" }, ctx);
    expect(second.content).toMatch(/unchanged since last read/i);
    expect(second.structured).toMatchObject({
      path: "src/app.ts",
      type: "file_unchanged",
    });
  });
});
