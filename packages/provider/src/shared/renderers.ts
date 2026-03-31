import type {
  AgentMessage,
  MessageRenderer,
  ToolCall,
  ToolDefinition,
  ToolRenderer,
} from "@renx/model";

import type { OpenAIChatMessage, OpenAIToolCall, OpenAIToolDefinition } from "./types";

export class OpenAIChatMessageRenderer implements MessageRenderer<OpenAIChatMessage> {
  renderSystemPrompt(systemPrompt: string): OpenAIChatMessage | null {
    if (systemPrompt.trim().length === 0) {
      return null;
    }

    return { role: "system", content: systemPrompt };
  }

  renderMessages(messages: AgentMessage[]): OpenAIChatMessage[] {
    return messages.map((message) => {
      if (message.role === "tool") {
        const toolMessage: OpenAIChatMessage = {
          role: "tool",
          content: message.content,
        };

        if (message.name !== undefined) {
          toolMessage.name = message.name;
        }

        if (message.toolCallId !== undefined) {
          toolMessage.tool_call_id = message.toolCallId;
        }

        return toolMessage;
      }

      const renderedMessage: OpenAIChatMessage = {
        role: message.role,
        content: message.content,
      };

      if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
        renderedMessage.tool_calls = message.toolCalls.map(renderToolCall);
      }

      return renderedMessage;
    });
  }
}

export class OpenAIToolRenderer implements ToolRenderer<OpenAIToolDefinition> {
  renderTools(tools: ToolDefinition[]): OpenAIToolDefinition[] {
    return tools.map((tool) => {
      const toolDefinition: OpenAIToolDefinition = {
        type: "function",
        function: {
          name: tool.name,
          parameters: tool.inputSchema,
        },
      };

      if (tool.description !== undefined) {
        toolDefinition.function.description = tool.description;
      }

      return toolDefinition;
    });
  }
}

const renderToolCall = (toolCall: ToolCall): OpenAIToolCall => ({
  id: toolCall.id,
  type: "function",
  function: {
    name: toolCall.name,
    arguments: JSON.stringify(toolCall.input),
  },
});
