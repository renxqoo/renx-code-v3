import type { AgentTool } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import { buildPlatformPatch, getPlatformState, nowIso, okToolResult } from "./shared";

const TEAM_CREATE_PROMPT = `
# TeamCreate

## When to Use

Use this tool proactively whenever:
- The user explicitly asks to use a team, swarm, or group of agents
- The user mentions wanting agents to work together, coordinate, or collaborate
- A task is complex enough that it would benefit from parallel work by multiple agents

When in doubt about whether a task warrants a team, prefer spawning a team.

## Automatic Message Delivery

Messages from teammates are automatically delivered to you. You do NOT need to manually check your inbox.

## Team Workflow

1. Create a team with TeamCreate
2. Create tasks using the Task tools
3. Spawn teammates using the Agent tool
4. Assign tasks using TaskUpdate
5. Shutdown the team when work is complete
`.trim();

const TEAM_DELETE_PROMPT = `
# TeamDelete

Remove team and task directories when the swarm work is complete.

This operation:
- Removes the team directory
- Removes the task directory
- Clears team context from the current session

IMPORTANT: TeamDelete will fail if the team still has active members. Gracefully terminate teammates first, then call TeamDelete after all teammates have shut down.
`.trim();

export const createTeamCreateTool = (): AgentTool => {
  const schema = z.object({
    team_name: z.string().min(1),
    description: z.string().optional(),
    agent_type: z.string().optional(),
  });

  return {
    name: "TeamCreate",
    description: TEAM_CREATE_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["collaboration", "team"],
      sandboxExpectation: "read-only",
      auditCategory: "collaboration",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      return okToolResult(`Created team ${parsed.team_name}.`, {
        statePatch: buildPlatformPatch(ctx, (state) => ({
          ...state,
          activeTeam: parsed.team_name,
          teams: {
            ...state.teams,
            [parsed.team_name]: {
              team_name: parsed.team_name,
              ...(parsed.description ? { description: parsed.description } : {}),
              ...(parsed.agent_type ? { agent_type: parsed.agent_type } : {}),
              members: ["team-lead"],
              updatedAt: nowIso(),
            },
          },
        })),
      });
    },
  };
};

export const createTeamDeleteTool = (): AgentTool => {
  const schema = z.object({});

  return {
    name: "TeamDelete",
    description: TEAM_DELETE_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["collaboration", "team"],
      sandboxExpectation: "read-only",
      auditCategory: "collaboration",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      schema.parse(input);
      const platformState = getPlatformState(ctx);
      const activeTeam = platformState.activeTeam;
      if (!activeTeam) {
        return okToolResult("No active team name found, nothing to clean up.");
      }
      const team = platformState.teams[activeTeam];
      if (team && team.members.some((member) => member !== "team-lead")) {
        throw new Error(
          `TeamDelete will fail if the team still has active members: ${team.members.join(", ")}`,
        );
      }
      return okToolResult(`Deleted team ${activeTeam}.`, {
        statePatch: buildPlatformPatch(ctx, (state) => {
          const teams = { ...state.teams };
          delete teams[activeTeam];
          const { activeTeam: _removedActiveTeam, ...restState } = state;
          return {
            ...restState,
            teams,
          };
        }),
      });
    },
  };
};
