import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createToolCapabilityProfile } from "../../src/tool/capability";
import { DefaultBackendResolver } from "../../src/tool/default-backend-resolver";
import type { AgentTool, ExecutionBackend, ToolResult } from "../../src/tool/types";
import { baseCtx } from "../helpers";

const localBackend: ExecutionBackend = {
  kind: "local",
  capabilities: () => ({ exec: true, filesystemRead: true, filesystemWrite: true, network: true }),
};

const sandboxBackend: ExecutionBackend = {
  kind: "sandbox",
  capabilities: () => ({ exec: true, filesystemRead: true, filesystemWrite: true, network: false }),
};

const resolver = new DefaultBackendResolver(localBackend, sandboxBackend);

describe("DefaultBackendResolver", () => {
  it("routes tools with 'requires-exec' capability to sandbox backend", async () => {
    const tool: AgentTool = {
      name: "shell",
      description: "Runs shell commands",
      schema: z.object({}).passthrough(),
      capabilities: ["requires-exec"],
      invoke: async (): Promise<ToolResult> => ({ content: "ok" }),
    };

    const result = await resolver.resolve(baseCtx(), tool, {
      id: "tc_1",
      name: "shell",
      input: {},
    });
    expect(result).toBe(sandboxBackend);
  });

  it("routes tools with 'requires-filesystem-read' to sandbox backend", async () => {
    const tool: AgentTool = {
      name: "read-file",
      description: "Reads files",
      schema: z.object({}).passthrough(),
      capabilities: ["requires-filesystem-read"],
      invoke: async (): Promise<ToolResult> => ({ content: "ok" }),
    };

    const result = await resolver.resolve(baseCtx(), tool, {
      id: "tc_1",
      name: "read-file",
      input: {},
    });
    expect(result).toBe(sandboxBackend);
  });

  it("routes tools with 'requires-filesystem-write' to sandbox backend", async () => {
    const tool: AgentTool = {
      name: "write-file",
      description: "Writes files",
      schema: z.object({}).passthrough(),
      capabilities: ["requires-filesystem-write"],
      invoke: async (): Promise<ToolResult> => ({ content: "ok" }),
    };

    const result = await resolver.resolve(baseCtx(), tool, {
      id: "tc_1",
      name: "write-file",
      input: {},
    });
    expect(result).toBe(sandboxBackend);
  });

  it("routes regular tools to local backend", async () => {
    const tool: AgentTool = {
      name: "echo",
      description: "Echoes input",
      schema: z.object({}).passthrough(),
      invoke: async (): Promise<ToolResult> => ({ content: "ok" }),
    };

    const result = await resolver.resolve(baseCtx(), tool, { id: "tc_1", name: "echo", input: {} });
    expect(result).toBe(localBackend);
  });

  it("routes tools with legacy 'exec' capability to sandbox backend", async () => {
    const tool: AgentTool = {
      name: "bash",
      description: "Runs shell commands",
      schema: z.object({}).passthrough(),
      capabilities: ["exec", "bash"],
      invoke: async (): Promise<ToolResult> => ({ content: "ok" }),
    };

    const result = await resolver.resolve(baseCtx(), tool, {
      id: "tc_legacy_exec",
      name: "bash",
      input: {},
    });
    expect(result).toBe(sandboxBackend);
  });

  it("routes tools with process_exec profile tag to sandbox backend", async () => {
    const tool: AgentTool = {
      name: "powershell",
      description: "Runs powershell commands",
      schema: z.object({}).passthrough(),
      profile: createToolCapabilityProfile({
        riskLevel: "high",
        capabilityTags: ["process_exec", "powershell"],
        sandboxExpectation: "workspace-write",
        auditCategory: "exec",
      }),
      invoke: async (): Promise<ToolResult> => ({ content: "ok" }),
    };

    const result = await resolver.resolve(baseCtx(), tool, {
      id: "tc_profile_exec",
      name: "powershell",
      input: {},
    });
    expect(result).toBe(sandboxBackend);
  });

  it("routes tools with filesystem profile tags to sandbox backend", async () => {
    const tool: AgentTool = {
      name: "notebook-edit",
      description: "Edits notebook files",
      schema: z.object({}).passthrough(),
      profile: createToolCapabilityProfile({
        riskLevel: "high",
        capabilityTags: ["filesystem_read", "filesystem_write", "notebook"],
        sandboxExpectation: "workspace-write",
        auditCategory: "file_edit",
      }),
      invoke: async (): Promise<ToolResult> => ({ content: "ok" }),
    };

    const result = await resolver.resolve(baseCtx(), tool, {
      id: "tc_profile_fs",
      name: "notebook-edit",
      input: {},
    });
    expect(result).toBe(sandboxBackend);
  });
});
