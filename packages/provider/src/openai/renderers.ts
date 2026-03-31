import type {
  AgentMessage,
  MessageRenderer,
  ToolCall,
  ToolDefinition,
  ToolRenderer,
} from "@renx/model";

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

export class OpenAIMessageRenderer implements MessageRenderer<OpenAIChatMessage> {
  renderSystemPrompt(systemPrompt: string): OpenAIChatMessage | null {
    if (systemPrompt.trim().length === 0) {
      return null;
    }

    return {
      role: "system",
      content: systemPrompt,
    };
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

      const toolCalls = readToolCalls(message.metadata);

      if (toolCalls.length > 0) {
        renderedMessage.tool_calls = toolCalls.map(renderToolCall);
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

const readToolCalls = (metadata: Record<string, unknown> | undefined): ToolCall[] => {
  const toolCalls = metadata?.toolCalls;

  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.flatMap((toolCall) => {
    if (!isToolCall(toolCall)) {
      return [];
    }

    return [toolCall];
  });
};

const renderToolCall = (toolCall: ToolCall): OpenAIToolCall => {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input),
    },
  };
};

const isToolCall = (value: unknown): value is ToolCall => {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.id === "string" && typeof value.name === "string" && "input" in value;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};
