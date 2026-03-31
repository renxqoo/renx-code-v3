import type { AgentMessage, MessageRenderer, ToolDefinition, ToolRenderer } from "@renx/model";
import type { OpenAIChatMessage, OpenAIToolDefinition } from "./types";
export declare class OpenAIChatMessageRenderer implements MessageRenderer<OpenAIChatMessage> {
    renderSystemPrompt(systemPrompt: string): OpenAIChatMessage | null;
    renderMessages(messages: AgentMessage[]): OpenAIChatMessage[];
}
export declare class OpenAIToolRenderer implements ToolRenderer<OpenAIToolDefinition> {
    renderTools(tools: ToolDefinition[]): OpenAIToolDefinition[];
}
//# sourceMappingURL=renderers.d.ts.map