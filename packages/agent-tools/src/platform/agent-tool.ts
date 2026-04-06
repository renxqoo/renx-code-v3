import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { AgentTool } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import { registerBackgroundAgentTask } from "./background-task-store";
import {
  buildPlatformPatch,
  getAgentRunnerProvider,
  nowIso,
  okToolResult,
  type PlatformAgentRecord,
} from "./shared";
import { getWorkspaceRoot, resolveWorkspacePath } from "../workspace/shared";

const AGENT_TOOL_DESCRIPTION = `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents (subprocesses) that autonomously handle complex tasks.

When using the Agent tool, specify a \`subagent_type\` parameter to select which agent type to use. If omitted, the general-purpose agent is used.

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user.
- You can optionally run agents in the background using the run_in_background parameter.
- To continue a previously spawned agent, use SendMessage with the agent's ID or name as the \`to\` field. The agent resumes with its full context preserved.
- Clearly tell the agent whether you expect it to write code or just to do research.
- You can optionally set \`isolation: "worktree"\` to run the agent in a temporary git worktree.

## Writing the prompt

When spawning a fresh agent, it starts with zero context. Brief the agent like a smart colleague who just walked into the room.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- Never delegate understanding. Include file paths, line numbers, and what specifically to change.`;

const appendAgentTranscript = (
  messages: Array<{ content: string; createdAt: string }>,
  transcript: string | undefined,
): Array<{ content: string; createdAt: string }> => {
  if (!transcript) return messages;
  const trimmed = transcript.trim();
  if (!trimmed) return messages;
  if (messages.some((entry) => entry.content === trimmed)) {
    return messages;
  }
  return [
    ...messages,
    {
      content: trimmed,
      createdAt: nowIso(),
    },
  ];
};

const mergeBackgroundAgentResult = (
  current: PlatformAgentRecord,
  result: {
    status?: "running" | "paused" | "completed" | "failed";
    output?: unknown;
    transcript?: string;
    outputFile?: string;
    sharedContext?: Record<string, unknown>;
  },
): PlatformAgentRecord => ({
  ...current,
  ...(result.status ? { status: result.status } : {}),
  ...(result.output !== undefined ? { output: result.output } : {}),
  ...(result.outputFile ? { outputFile: result.outputFile } : {}),
  messages: appendAgentTranscript(current.messages, result.transcript),
  sharedContext: {
    ...current.sharedContext,
    ...(result.sharedContext ?? {}),
  },
  updatedAt: nowIso(),
});

export const createAgentTool = (): AgentTool => {
  const schema = z.object({
    description: z.string().min(1),
    prompt: z.string().min(1),
    subagent_type: z.string().optional(),
    model: z.string().optional(),
    run_in_background: z.boolean().optional(),
    name: z.string().optional(),
    team_name: z.string().optional(),
    mode: z.string().optional(),
    isolation: z.enum(["worktree", "remote"]).optional(),
    cwd: z.string().optional(),
  });

  return {
    name: "Agent",
    description: AGENT_TOOL_DESCRIPTION,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "medium",
      capabilityTags: ["collaboration", "agent"],
      sandboxExpectation: "read-only",
      auditCategory: "collaboration",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      if (parsed.isolation && parsed.cwd) {
        throw new Error("isolation and cwd are mutually exclusive for agent spawn.");
      }
      if (parsed.isolation === "remote" && !parsed.run_in_background) {
        throw new Error("remote isolation requires run_in_background=true.");
      }

      const agentId = parsed.name ?? `agent_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const runner = getAgentRunnerProvider(ctx);
      const resolvedCwd = parsed.cwd ? await resolveWorkspacePath(ctx, parsed.cwd) : undefined;
      const role = parsed.subagent_type ?? "general-purpose";
      const objective = parsed.prompt;
      const startedAt = nowIso();
      const sharedContext = {
        description: parsed.description,
        prompt: parsed.prompt,
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(parsed.team_name ? { teamName: parsed.team_name } : {}),
        ...(parsed.mode ? { mode: parsed.mode } : {}),
      };

      const runnerRequest = {
        id: agentId,
        role,
        objective,
        ...(parsed.isolation ? { isolation: parsed.isolation } : {}),
        ...(resolvedCwd ? { cwd: resolvedCwd.fullPath } : {}),
        runInBackground: parsed.run_in_background ?? false,
        sharedContext,
      } as const;

      if (parsed.run_in_background) {
        const outputDir = join(getWorkspaceRoot(ctx), ".renx-tool-results");
        const defaultOutputFile = join(outputDir, `${agentId}.agent.log`);

        if (runner?.launchBackground) {
          const launched = await runner.launchBackground(runnerRequest);
          const taskId = launched.taskId ?? agentId;
          let currentRecord: PlatformAgentRecord = {
            id: agentId,
            taskId,
            role,
            objective,
            status: launched.status,
            ...(parsed.isolation ? { isolation: parsed.isolation } : {}),
            ...(resolvedCwd ? { cwd: resolvedCwd.fullPath } : {}),
            outputFile: launched.outputFile ?? defaultOutputFile,
            runInBackground: true,
            ...(launched.output !== undefined ? { output: launched.output } : {}),
            messages: appendAgentTranscript([], launched.transcript),
            sharedContext: {
              ...sharedContext,
              ...(launched.sharedContext ?? {}),
            },
            updatedAt: startedAt,
          };
          registerBackgroundAgentTask(
            ctx.runContext.state.runId,
            taskId,
            currentRecord,
            runner.getStatus
              ? {
                  refresh: async () => {
                    const latest = await runner.getStatus!(agentId);
                    if (!latest) return currentRecord;
                    currentRecord = mergeBackgroundAgentResult(currentRecord, latest);
                    return currentRecord;
                  },
                }
              : undefined,
          );
          return okToolResult(`Spawned background agent ${agentId}.`, {
            structured: {
              status: launched.status === "running" ? "async_launched" : launched.status,
              agent_id: agentId,
              taskId,
              output_file: launched.outputFile ?? defaultOutputFile,
              ...(parsed.isolation ? { isolation: parsed.isolation } : {}),
              ...(resolvedCwd ? { cwd: resolvedCwd.fullPath } : {}),
            },
            statePatch: buildPlatformPatch(ctx, (state) => ({
              ...state,
              agents: {
                ...state.agents,
                [agentId]: {
                  ...currentRecord,
                },
              },
            })),
          });
        }

        const taskId = agentId;
        const initialRecord: PlatformAgentRecord = {
          id: agentId,
          taskId,
          role,
          objective,
          status: "running",
          ...(parsed.isolation ? { isolation: parsed.isolation } : {}),
          ...(resolvedCwd ? { cwd: resolvedCwd.fullPath } : {}),
          outputFile: defaultOutputFile,
          runInBackground: true,
          messages: [],
          sharedContext,
          updatedAt: startedAt,
        };
        const controller = registerBackgroundAgentTask(
          ctx.runContext.state.runId,
          taskId,
          initialRecord,
        );

        const statePatch = buildPlatformPatch(ctx, (state) => ({
          ...state,
          agents: {
            ...state.agents,
            [agentId]: {
              ...initialRecord,
            },
          },
        }));

        void (async () => {
          try {
            await mkdir(outputDir, { recursive: true });
            await writeFile(
              defaultOutputFile,
              JSON.stringify(
                {
                  agentId,
                  description: parsed.description,
                  prompt: parsed.prompt,
                  subagentType: parsed.subagent_type ?? null,
                  model: parsed.model ?? null,
                },
                null,
                2,
              ),
              "utf8",
            );
            controller.update((state) => ({
              ...state,
              status: "completed",
              outputFile: defaultOutputFile,
              runInBackground: true,
              updatedAt: nowIso(),
            }));
          } catch (error) {
            controller.update((state) => ({
              ...state,
              status: "failed",
              reason: error instanceof Error ? error.message : String(error),
              updatedAt: nowIso(),
            }));
          }
        })();

        return okToolResult(`Spawned background agent ${agentId}.`, {
          structured: {
            status: "async_launched",
            agent_id: agentId,
            taskId,
            output_file: defaultOutputFile,
            ...(parsed.isolation ? { isolation: parsed.isolation } : {}),
            ...(resolvedCwd ? { cwd: resolvedCwd.fullPath } : {}),
          },
          statePatch,
        });
      }

      if (runner?.runSync) {
        const runnerResult = await runner.runSync(runnerRequest);
        return okToolResult(`Agent ${agentId} ${runnerResult.status}.`, {
          structured: {
            status: runnerResult.status,
            agent_id: agentId,
            ...(runnerResult.output !== undefined ? { output: runnerResult.output } : {}),
            ...(runnerResult.transcript ? { transcript: runnerResult.transcript } : {}),
          },
          statePatch: buildPlatformPatch(ctx, (state) => ({
            ...state,
            agents: {
              ...state.agents,
              [agentId]: {
                id: agentId,
                role,
                objective,
                status: runnerResult.status,
                ...(parsed.isolation ? { isolation: parsed.isolation } : {}),
                ...(resolvedCwd ? { cwd: resolvedCwd.fullPath } : {}),
                ...(runnerResult.output !== undefined ? { output: runnerResult.output } : {}),
                messages: appendAgentTranscript([], runnerResult.transcript),
                sharedContext,
                updatedAt: nowIso(),
              },
            },
          })),
        });
      }

      return okToolResult(`Spawned agent ${agentId}.`, {
        structured: {
          status: "running",
          agent_id: agentId,
        },
        statePatch: buildPlatformPatch(ctx, (state) => ({
          ...state,
          agents: {
            ...state.agents,
            [agentId]: {
              id: agentId,
              role,
              objective,
              status: "running",
              ...(parsed.isolation ? { isolation: parsed.isolation } : {}),
              ...(resolvedCwd ? { cwd: resolvedCwd.fullPath } : {}),
              messages: [],
              sharedContext,
              updatedAt: nowIso(),
            },
          },
        })),
      });
    },
  };
};
