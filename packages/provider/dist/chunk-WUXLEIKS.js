// src/openai/renderers.ts
var OpenAIMessageRenderer = class {
  renderSystemPrompt(systemPrompt) {
    if (systemPrompt.trim().length === 0) {
      return null;
    }
    return {
      role: "system",
      content: systemPrompt
    };
  }
  renderMessages(messages) {
    return messages.map((message) => {
      if (message.role === "tool") {
        const toolMessage = {
          role: "tool",
          content: message.content
        };
        if (message.name !== void 0) {
          toolMessage.name = message.name;
        }
        if (message.toolCallId !== void 0) {
          toolMessage.tool_call_id = message.toolCallId;
        }
        return toolMessage;
      }
      const renderedMessage = {
        role: message.role,
        content: message.content
      };
      const toolCalls = readToolCalls(message.metadata);
      if (toolCalls.length > 0) {
        renderedMessage.tool_calls = toolCalls.map(renderToolCall);
      }
      return renderedMessage;
    });
  }
};
var OpenAIToolRenderer = class {
  renderTools(tools) {
    return tools.map((tool) => {
      const toolDefinition = {
        type: "function",
        function: {
          name: tool.name,
          parameters: tool.inputSchema
        }
      };
      if (tool.description !== void 0) {
        toolDefinition.function.description = tool.description;
      }
      return toolDefinition;
    });
  }
};
var readToolCalls = (metadata) => {
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
var renderToolCall = (toolCall) => {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input)
    }
  };
};
var isToolCall = (value) => {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === "string" && typeof value.name === "string" && "input" in value;
};
var isRecord = (value) => {
  return typeof value === "object" && value !== null;
};

// src/openai/response-normalizer.ts
var OpenAIResponseNormalizer = class {
  normalize(response) {
    const message = readMessage(response.body);
    if (!message) {
      return {
        type: "final",
        output: ""
      };
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return {
        type: "tool_calls",
        toolCalls: message.tool_calls.flatMap((toolCall) => {
          if (!isOpenAIToolCall(toolCall)) {
            return [];
          }
          return [
            {
              id: toolCall.id,
              name: toolCall.function.name,
              input: parseToolArguments(toolCall.function.arguments)
            }
          ];
        })
      };
    }
    return {
      type: "final",
      output: extractText(message.content)
    };
  }
};
var readMessage = (body) => {
  if (!isRecord2(body)) {
    return null;
  }
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const [firstChoice] = choices;
  if (!isRecord2(firstChoice) || !isRecord2(firstChoice.message)) {
    return null;
  }
  return firstChoice.message;
};
var extractText = (content) => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.flatMap((chunk) => {
    if (!isRecord2(chunk)) {
      return [];
    }
    if (typeof chunk.text === "string") {
      return [chunk.text];
    }
    return [];
  }).join("");
};
var parseToolArguments = (argumentsText) => {
  if (argumentsText.length === 0) {
    return {};
  }
  try {
    return JSON.parse(argumentsText);
  } catch {
    return {
      raw: argumentsText
    };
  }
};
var isOpenAIToolCall = (value) => {
  if (!isRecord2(value) || !isRecord2(value.function)) {
    return false;
  }
  return typeof value.id === "string" && value.type === "function" && typeof value.function.name === "string" && typeof value.function.arguments === "string";
};
var isRecord2 = (value) => {
  return typeof value === "object" && value !== null;
};

export {
  OpenAIMessageRenderer,
  OpenAIToolRenderer,
  OpenAIResponseNormalizer
};
//# sourceMappingURL=chunk-WUXLEIKS.js.map