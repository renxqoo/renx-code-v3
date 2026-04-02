import type { ModelResponse, ProviderResponse, ResponseNormalizer, TokenUsage } from "@renx/model";

import type { OpenAIToolCall } from "./types";

export class OpenAIResponseNormalizer implements ResponseNormalizer {
  normalize(response: ProviderResponse): ModelResponse {
    const responseId = readResponseId(response.body);
    const usage = readUsage(response.body);
    const message = readMessage(response.body);

    if (!message) {
      return {
        type: "final",
        output: "",
        ...(responseId ? { responseId } : {}),
        ...(usage ? { usage } : {}),
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
              input: parseToolArguments(toolCall.function.arguments),
            },
          ];
        }),
        ...(responseId ? { responseId } : {}),
        ...(usage ? { usage } : {}),
      };
    }

    return {
      type: "final",
      output: extractText(message.content),
      ...(responseId ? { responseId } : {}),
      ...(usage ? { usage } : {}),
    };
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

const readResponseId = (body: unknown): string | undefined => {
  if (!isRecord(body)) return undefined;
  return typeof body.id === "string" ? body.id : undefined;
};

const readUsage = (body: unknown): TokenUsage | undefined => {
  if (!isRecord(body) || !isRecord(body.usage)) return undefined;
  const usage = body.usage;
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : undefined;
  const promptDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : undefined;
  const readNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const inputTokens = readNumber(usage.prompt_tokens);
  const outputTokens = readNumber(usage.completion_tokens);
  const totalTokens = readNumber(usage.total_tokens);
  const reasoningTokens = completionDetails
    ? readNumber(completionDetails.reasoning_tokens)
    : undefined;
  const cacheReadInputTokens = promptDetails ? readNumber(promptDetails.cached_tokens) : undefined;

  const mapped: TokenUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
  };

  return Object.keys(mapped).length > 0 ? mapped : undefined;
};
