import type { AgentTool } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import { buildPlatformPatch, getPlatformState, nowIso, okToolResult } from "./shared";

const CONFIG_TOOL_PROMPT = `Get or set Claude Code configuration settings.

View or change Claude Code settings. Use when the user requests configuration changes, asks about current settings, or when adjusting a setting would benefit them.

## Usage
- Get current value: Omit the "value" parameter
- Set new value: Include the "value" parameter

## Configurable settings list
The following settings are available for you to change:

### Global Settings
- theme: string - Color theme for the UI
- verbose: true/false - Show detailed debug output

### Project Settings
- model: string - Override the default model
- permissions.defaultMode: string - Default permission mode for tool usage

## Examples
- Get theme: { "setting": "theme" }
- Set dark theme: { "setting": "theme", "value": "dark" }
- Change model: { "setting": "model", "value": "opus" }`;

export const createConfigTool = (): AgentTool => {
  const schema = z.object({
    setting: z.string().min(1),
    value: z.union([z.string(), z.boolean(), z.number()]).optional(),
  });
  return {
    name: "config",
    description: CONFIG_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "medium",
      capabilityTags: ["configuration"],
      sandboxExpectation: "read-only",
      auditCategory: "config",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: (input) => {
      const parsed = schema.safeParse(input);
      return parsed.success ? parsed.data.value === undefined : false;
    },
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      if (parsed.value === undefined) {
        const current = getPlatformState(ctx).config[parsed.setting]?.value;
        return okToolResult(`${parsed.setting} = ${JSON.stringify(current ?? null)}`, {
          structured: {
            success: true,
            operation: "get",
            setting: parsed.setting,
            value: current ?? null,
          },
        });
      }
      return okToolResult(`Set ${parsed.setting} to ${JSON.stringify(parsed.value)}`, {
        structured: {
          success: true,
          operation: "set",
          setting: parsed.setting,
          newValue: parsed.value,
        },
        statePatch: buildPlatformPatch(ctx, (state) => ({
          ...state,
          config: {
            ...state.config,
            [parsed.setting]: {
              scope: "run",
              value: parsed.value,
              updatedAt: nowIso(),
            },
          },
        })),
      });
    },
  };
};
