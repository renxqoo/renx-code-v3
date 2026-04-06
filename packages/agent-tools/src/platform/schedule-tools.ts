import type { AgentTool } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { buildPlatformPatch, getPlatformState, nowIso, okToolResult } from "./shared";

const CRON_CREATE_PROMPT = `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week.

## One-shot tasks (recurring: false)
For "remind me at X" or "at <time>, do Y" requests - fire once then auto-delete.

## Recurring jobs (recurring: true, the default)
For "every N minutes" / "every hour" / "weekdays at 9am" requests.

Returns a job ID you can pass to CronDelete.`;

const CRON_LIST_PROMPT = "List all cron jobs scheduled via CronCreate in this session.";
const CRON_DELETE_PROMPT =
  "Cancel a cron job previously scheduled with CronCreate. Removes it from the in-memory session store.";

export const createScheduleCronCreateTool = (): AgentTool => {
  const schema = z.object({
    cron: z.string().min(1),
    prompt: z.string().min(1),
    recurring: z.boolean().optional(),
    durable: z.boolean().optional(),
  });
  return {
    name: "CronCreate",
    description: CRON_CREATE_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "medium",
      capabilityTags: ["scheduling"],
      sandboxExpectation: "read-only",
      auditCategory: "scheduling",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const id = `cron_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      return okToolResult(`Created schedule ${id}.`, {
        statePatch: buildPlatformPatch(ctx, (state) => ({
          ...state,
          schedules: {
            ...state.schedules,
            [id]: {
              id,
              name: parsed.cron,
              schedule: parsed.cron,
              prompt: parsed.prompt,
              updatedAt: nowIso(),
              ...(parsed.recurring !== undefined ? { recurring: parsed.recurring } : {}),
              ...(parsed.durable !== undefined ? { durable: parsed.durable } : {}),
            },
          },
        })),
      });
    },
  };
};

export const createScheduleCronListTool = (): AgentTool => {
  const schema = z.object({});
  return {
    name: "CronList",
    description: CRON_LIST_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["scheduling"],
      sandboxExpectation: "read-only",
      auditCategory: "scheduling",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (_input, ctx) => {
      const schedules = Object.values(getPlatformState(ctx).schedules);
      return okToolResult(
        schedules.length > 0
          ? schedules.map((item) => `${item.id}: ${item.name} -> ${item.schedule}`).join("\n")
          : "No scheduled jobs.",
        { structured: schedules },
      );
    },
  };
};

export const createScheduleCronDeleteTool = (): AgentTool => {
  const schema = z.object({ id: z.string().min(1) });
  return {
    name: "CronDelete",
    description: CRON_DELETE_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["scheduling"],
      sandboxExpectation: "read-only",
      auditCategory: "scheduling",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      return okToolResult(`Deleted schedule ${parsed.id}.`, {
        statePatch: buildPlatformPatch(ctx, (state) => {
          const schedules = { ...state.schedules };
          delete schedules[parsed.id];
          return { ...state, schedules };
        }),
      });
    },
  };
};
