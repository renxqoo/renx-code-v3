import type { AgentTool, ToolRegistry } from "./types";
export declare class InMemoryToolRegistry implements ToolRegistry {
    private readonly tools;
    register(tool: AgentTool): void;
    get(name: string): AgentTool | undefined;
    list(): AgentTool[];
}
//# sourceMappingURL=registry.d.ts.map