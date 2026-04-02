import type { AgentMessage } from "@renx/model";

const IMAGE_MARKDOWN = /!\[[^\]]*\]\([^)]+\)/g;
const DATA_IMAGE = /data:image\/[a-zA-Z+.-]+;base64,[a-zA-Z0-9+/=]+/g;
const DOCUMENT_LINK = /\[[^\]]*\]\(([^)]+\.(?:pdf|docx?|pptx?|xlsx?|txt|md))\)/gi;

const stripMediaFromContent = (content: string): string => {
  return content
    .replace(IMAGE_MARKDOWN, "[image]")
    .replace(DATA_IMAGE, "[image]")
    .replace(DOCUMENT_LINK, "[document]");
};

export const stripMediaFromMessages = (messages: AgentMessage[]): AgentMessage[] => {
  return messages.map((message) => {
    const stripped = stripMediaFromContent(message.content);
    if (stripped === message.content) return message;
    return {
      ...message,
      content: stripped,
      metadata: {
        ...message.metadata,
        mediaStripped: true,
      },
    };
  });
};
