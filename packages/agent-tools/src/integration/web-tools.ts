import type { AgentTool } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import {
  getMcpProvider,
  getRemoteTriggerProvider,
  getWebSearchProvider,
  okToolResult,
} from "../platform/shared";

const WEB_FETCH_TOOL_PROMPT = `
- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).
`.trim();

const WEB_SEARCH_TOOL_PROMPT = `
- Allows Claude to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond Claude's knowledge cutoff
- Searches are performed automatically within a single API call

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response

Usage notes:
  - Domain filtering is supported to include or block specific websites
  - Web search is only available in the US
`.trim();

const LIST_MCP_RESOURCES_PROMPT = `
List available resources from configured MCP servers.
Each returned resource will include all standard MCP resource fields plus a 'server' field
indicating which server the resource belongs to.

Parameters:
- server (optional): The name of a specific MCP server to get resources from. If not provided,
  resources from all servers will be returned.
`.trim();

const READ_MCP_RESOURCE_PROMPT = `
Reads a specific resource from an MCP server, identified by server name and resource URI.

Parameters:
- server (required): The name of the MCP server from which to read the resource
- uri (required): The URI of the resource to read
`.trim();

const MCP_AUTH_TOOL_PROMPT = `The target MCP server requires authentication before its real tools become available. Call this tool to start the authentication flow and obtain an authorization URL or status message for the user.`;

const MCP_TOOL_PROMPT = `Call a generic MCP tool through the injected provider. Provide the target server and tool name, plus an optional arguments object. Use this when you need to invoke a concrete MCP capability but the SDK is exposing MCP through a generic transport tool instead of one tool per MCP method.`;

const REMOTE_TRIGGER_TOOL_PROMPT = `Call the claude.ai remote-trigger API. Use this instead of curl - the OAuth token is added automatically in-process and never exposed.

Actions:
- list: GET /v1/code/triggers
- get: GET /v1/code/triggers/{trigger_id}
- create: POST /v1/code/triggers (requires body)
- update: POST /v1/code/triggers/{trigger_id} (requires body, partial update)
- run: POST /v1/code/triggers/{trigger_id}/run

The response is the raw JSON from the API.`;

const stripHtml = (value: string): string =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const createWebFetchTool = (): AgentTool => {
  const schema = z.object({
    url: z.string().url(),
    prompt: z.string().min(1),
  });

  return {
    name: "WebFetch",
    description: WEB_FETCH_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "medium",
      capabilityTags: ["network"],
      sandboxExpectation: "full-access",
      auditCategory: "network",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input) => {
      const parsed = schema.parse(input);
      const response = await fetch(parsed.url);
      const body = await response.text();
      const text = stripHtml(body);
      return okToolResult(text.length > 0 ? text : parsed.prompt, {
        structured: { url: parsed.url, prompt: parsed.prompt, status: response.status },
      });
    },
  };
};

export const createWebSearchTool = (): AgentTool => {
  const schema = z.object({
    query: z.string().min(1),
    allowed_domains: z.array(z.string()).optional(),
    blocked_domains: z.array(z.string()).optional(),
  });

  return {
    name: "WebSearch",
    description: WEB_SEARCH_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "medium",
      capabilityTags: ["network", "search"],
      sandboxExpectation: "full-access",
      auditCategory: "network",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const provider = getWebSearchProvider(ctx);
      if (!provider) throw new Error("No web search provider is configured.");
      const results = await provider({
        query: parsed.query,
        ...(parsed.allowed_domains ? { allowed_domains: parsed.allowed_domains } : {}),
        ...(parsed.blocked_domains ? { blocked_domains: parsed.blocked_domains } : {}),
      });
      return okToolResult(
        results
          .map((item) => `${item.title}\n${item.url}\n${item.snippet ?? ""}`.trim())
          .join("\n\n"),
        { structured: { query: parsed.query, results } },
      );
    },
  };
};

export const createListMcpResourcesTool = (): AgentTool => {
  const schema = z.object({
    server: z.string().min(1).optional(),
  });

  return {
    name: "ListMcpResources",
    description: LIST_MCP_RESOURCES_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["mcp"],
      sandboxExpectation: "read-only",
      auditCategory: "mcp",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const provider = getMcpProvider(ctx);
      if (!provider) throw new Error("No MCP provider is configured.");
      const resources = await provider.listResources(parsed.server);
      return okToolResult(
        resources
          .map((item) => `${item.id}: ${item.server}: ${item.name} (${item.uri})`)
          .join("\n"),
        {
          structured: resources,
        },
      );
    },
  };
};

export const createReadMcpResourceTool = (): AgentTool => {
  const schema = z.object({
    server: z.string().min(1),
    uri: z.string().min(1),
  });

  return {
    name: "ReadMcpResource",
    description: READ_MCP_RESOURCE_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["mcp"],
      sandboxExpectation: "read-only",
      auditCategory: "mcp",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx) => {
      const provider = getMcpProvider(ctx);
      if (!provider) throw new Error("No MCP provider is configured.");
      const parsed = schema.parse(input);
      const resource = await provider.readResource(parsed.server, parsed.uri);
      return okToolResult(resource.content, { structured: resource });
    },
  };
};

export const createMcpAuthTool = (): AgentTool => {
  const schema = z.object({
    server: z.string().min(1),
  });

  return {
    name: "McpAuth",
    description: MCP_AUTH_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "high",
      capabilityTags: ["mcp", "auth"],
      sandboxExpectation: "full-access",
      auditCategory: "mcp",
    }),
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const provider = getMcpProvider(ctx);
      if (!provider) throw new Error("No MCP provider is configured.");
      const parsed = schema.parse(input);
      const result = await provider.authenticate(parsed.server);
      return okToolResult(result.message, { structured: result });
    },
  };
};

export const createMcpTool = (): AgentTool => {
  const schema = z.object({
    server: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.unknown().optional(),
  });

  return {
    name: "MCP",
    description: MCP_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "medium",
      capabilityTags: ["mcp"],
      sandboxExpectation: "full-access",
      auditCategory: "mcp",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const provider = getMcpProvider(ctx);
      if (!provider) throw new Error("No MCP provider is configured.");
      const parsed = schema.parse(input);
      const result = await provider.callTool(parsed.server, parsed.tool, parsed.arguments);
      return okToolResult(JSON.stringify(result, null, 2), { structured: result });
    },
  };
};

export const createRemoteTriggerTool = (): AgentTool => {
  const schema = z.object({
    action: z.enum(["list", "get", "create", "update", "run"]),
    trigger_id: z.string().min(1).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
  });

  return {
    name: "RemoteTrigger",
    description: REMOTE_TRIGGER_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "medium",
      capabilityTags: ["network", "trigger"],
      sandboxExpectation: "full-access",
      auditCategory: "network",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: (input) => {
      const parsed = schema.safeParse(input);
      return parsed.success ? parsed.data.action === "list" || parsed.data.action === "get" : false;
    },
    invoke: async (input, ctx) => {
      const provider = getRemoteTriggerProvider(ctx);
      if (!provider) throw new Error("No remote trigger provider is configured.");
      const parsed = schema.parse(input);
      const result = await provider({
        action: parsed.action,
        ...(parsed.trigger_id ? { trigger_id: parsed.trigger_id } : {}),
        ...(parsed.body ? { body: parsed.body } : {}),
      });
      return okToolResult(JSON.stringify(result, null, 2), { structured: result });
    },
  };
};
