import type { AgentMessage, MessageRenderer, ToolDefinition, ToolRenderer } from "@renx/model";
export interface OpenAIChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string;
    tool_call_id?: string;
    tool_calls?: OpenAIToolCall[];
}
export interface OpenAIToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}
export interface OpenAIToolDefinition {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
    };
}
export declare class OpenAIMessageRenderer implements MessageRenderer<OpenAIChatMessage> {
    renderSystemPrompt(systemPrompt: string): OpenAIChatMessage | null;
    renderMessages(messages: AgentMessage[]): OpenAIChatMessage[];
}
export declare class OpenAIToolRenderer implements ToolRenderer<OpenAIToolDefinition> {
    renderTools(tools: ToolDefinition[]): OpenAIToolDefinition[];
}
//# sourceMappingURL=renderers.d.ts.map