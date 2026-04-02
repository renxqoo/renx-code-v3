import { describe, expect, it } from "vitest";
import { z } from "zod";

import { InMemoryToolRegistry } from "../../src/tool/registry";
import type { AgentTool, ToolResult } from "../../src/tool/types";

const echoTool: AgentTool = {
  name: "echo",
  description: "Echoes input",
  schema: z.object({}).passthrough(),
  invoke: async (input: unknown): Promise<ToolResult> => ({
    content: JSON.stringify(input),
  }),
};

const searchTool: AgentTool = {
  name: "search",
  description: "Searches for things",
  schema: z.object({}).passthrough(),
  invoke: async (input: unknown): Promise<ToolResult> => ({
    content: `Results for: ${JSON.stringify(input)}`,
  }),
};

describe("InMemoryToolRegistry", () => {
  it("registers and retrieves tools", () => {
    const registry = new InMemoryToolRegistry();
    registry.register(echoTool);
    registry.register(searchTool);

    expect(registry.get("echo")).toBe(echoTool);
    expect(registry.get("search")).toBe(searchTool);
  });

  it("returns undefined for unknown tool", () => {
    const registry = new InMemoryToolRegistry();
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("lists all registered tools", () => {
    const registry = new InMemoryToolRegistry();
    registry.register(echoTool);
    registry.register(searchTool);

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.name).sort()).toEqual(["echo", "search"]);
  });

  it("throws on duplicate registration", () => {
    const registry = new InMemoryToolRegistry();
    registry.register(echoTool);
    expect(() => registry.register(echoTool)).toThrow("Tool already registered: echo");
  });
});
