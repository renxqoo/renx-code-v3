import type { ModelResponse, ProviderResponse, ResponseNormalizer } from "@renx/model";

import type { OpenAIToolCall } from "./types";

export class OpenAIResponseNormalizer implements ResponseNormalizer {
  normalize(response: ProviderResponse): ModelResponse {
    const message = readMessage(response.body);

    if (!message) {
      return { type: "final", output: "" };
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
              input: parseToolArguments(toolCall.function.arguments),
            },
          ];
        }),
      };
    }

    return { type: "final", output: extractText(message.content) };
  }
}

const readMessage = (body: unknown): Record<string, unknown> | null => {
  if (!isRecord(body)) {
    return null;
  }

  const choices = body.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const [firstChoice] = choices;

  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    return null;
  }

  return firstChoice.message;
};

const extractText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((chunk) => {
      if (!isRecord(chunk)) {
        return [];
      }

      if (typeof chunk.text === "string") {
        return [chunk.text];
      }

      return [];
    })
    .join("");
};

const parseToolArguments = (argumentsText: string): unknown => {
  if (argumentsText.length === 0) {
    return {};
  }

  try {
    return JSON.parse(argumentsText) as unknown;
  } catch {
    return { raw: argumentsText };
  }
};

const isOpenAIToolCall = (value: unknown): value is OpenAIToolCall => {
  if (!isRecord(value) || !isRecord(value.function)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    value.type === "function" &&
    typeof value.function.name === "string" &&
    typeof value.function.arguments === "string"
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
