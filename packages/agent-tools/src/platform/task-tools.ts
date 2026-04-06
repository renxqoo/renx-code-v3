import { readFile } from "node:fs/promises";

import type { AgentTool } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import {
  getBackgroundAgentTaskSnapshot,
  getBackgroundShellTaskSnapshot,
  markBackgroundTaskCancelled,
  waitForBackgroundAgentTask,
  waitForBackgroundShellTask,
} from "./background-task-store";
import { buildPlatformPatch, getPlatformState, nowIso, okToolResult } from "./shared";

const TASK_CREATE_PROMPT = `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:
- Complex multi-step tasks
- Non-trivial and complex tasks
- Plan mode
- User explicitly requests todo list behavior
- User provides multiple tasks
- After receiving new instructions

## Task Fields

- subject: A brief, actionable title in imperative form
- description: What needs to be done
- activeForm (optional): Present continuous form shown in the spinner when the task is in_progress
`;

const TASK_UPDATE_PROMPT = `Use this tool to update a task in the task list.

## When to Use This Tool

- Mark tasks as resolved only when they are fully completed
- Delete tasks that are no longer relevant
- Update task details when requirements change
- Establish dependencies between tasks

## Status Workflow

Status progresses: \`pending\` -> \`in_progress\` -> \`completed\`

Use \`deleted\` to permanently remove a task.`;

const TASK_GET_PROMPT = `Use this tool to retrieve a task by its ID from the task list.

## Output

Returns full task details:
- subject
- description
- status
- blocks
- blockedBy`;

const TASK_LIST_PROMPT = `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on
- To check overall progress on the project
- To find blocked tasks
- After completing a task, to check for newly unblocked work
- Prefer working on tasks in ID order when multiple tasks are available`;

const TASK_STOP_PROMPT = `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task
`.trim();

const TASK_OUTPUT_PROMPT = `Use this tool to read output/logs from a background task.

- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Works with all task types: background shells, async agents, and remote sessions`;

const taskStatusSchema = z.enum(["pending", "in_progress", "completed"]);
const delay = async (ms: number): Promise<void> =>
  await new Promise<void>((resolve) => setTimeout(resolve, ms));

type BackgroundTaskOutput =
  | {
      task_id: string;
      task_type: "local_bash";
      status: string;
      description: string;
      output: string;
      exitCode?: number | null;
      error?: string;
    }
  | {
      task_id: string;
      task_type: "local_agent" | "remote_agent";
      status: string;
      description: string;
      output: string;
      prompt: string;
      result?: string;
      error?: string;
    };

const readTaskOutputFile = async (outputFile?: string): Promise<string> => {
  if (!outputFile) return "";
  try {
    return await readFile(outputFile, "utf8");
  } catch {
    return "";
  }
};

const stringifyTaskValue = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const describeAgentTask = (agent: {
  objective: string;
  sharedContext?: Record<string, unknown>;
}): string => {
  const description = agent.sharedContext?.["description"];
  return typeof description === "string" && description.length > 0 ? description : agent.objective;
};

const isAgentPending = (status: string): boolean => status === "running" || status === "paused";

const findAgentTaskRecord = (
  platformState: ReturnType<typeof getPlatformState>,
  taskId: string,
) => {
  const direct = platformState.agents[taskId];
  if (direct) return direct;
  return Object.values(platformState.agents).find((agent) => agent.taskId === taskId);
};

const getTaskOutputData = async (
  ctx: Parameters<typeof getPlatformState>[0],
  taskId: string,
): Promise<BackgroundTaskOutput> => {
  const platformState = getPlatformState(ctx);
  const shellTask =
    (await getBackgroundShellTaskSnapshot(ctx.runContext.state.runId, taskId)) ??
    platformState.shellCommands[taskId];
  if (shellTask) {
    const output = await readTaskOutputFile(shellTask.outputFile);
    return {
      task_id: taskId,
      task_type: "local_bash",
      status: shellTask.status,
      description: shellTask.description ?? shellTask.command,
      output,
      ...(shellTask.exitCode !== undefined ? { exitCode: shellTask.exitCode } : {}),
      ...(shellTask.error ? { error: shellTask.error } : {}),
    };
  }

  const agentTask =
    (await getBackgroundAgentTaskSnapshot(ctx.runContext.state.runId, taskId)) ??
    findAgentTaskRecord(platformState, taskId);
  if (agentTask) {
    const fileOutput = await readTaskOutputFile(agentTask.outputFile);
    const recordedOutput = stringifyTaskValue(agentTask.output);
    const transcriptOutput = agentTask.messages
      .map((message) => message.content.trim())
      .filter((message) => message.length > 0)
      .join("\n\n");
    const output = fileOutput || recordedOutput || transcriptOutput;
    return {
      task_id: agentTask.taskId ?? taskId,
      task_type: agentTask.isolation === "remote" ? "remote_agent" : "local_agent",
      status: agentTask.status,
      description: describeAgentTask(agentTask),
      prompt: agentTask.objective,
      output,
      ...(output ? { result: output } : {}),
      ...(agentTask.reason ? { error: agentTask.reason } : {}),
    };
  }

  throw new Error(`Task not found: ${taskId}`);
};

const isTaskReady = async (
  ctx: Parameters<typeof getPlatformState>[0],
  taskId: string,
): Promise<boolean> => {
  const liveShellTask = await getBackgroundShellTaskSnapshot(ctx.runContext.state.runId, taskId);
  if (liveShellTask) {
    return liveShellTask.status !== "running";
  }
  const liveAgentTask = await getBackgroundAgentTaskSnapshot(ctx.runContext.state.runId, taskId);
  if (liveAgentTask) {
    return !isAgentPending(liveAgentTask.status);
  }
  const platformState = getPlatformState(ctx);
  const shellTask = platformState.shellCommands[taskId];
  if (shellTask) {
    return shellTask.status !== "running";
  }
  const agentTask = findAgentTaskRecord(platformState, taskId);
  if (agentTask) {
    return !isAgentPending(agentTask.status);
  }
  throw new Error(`Task not found: ${taskId}`);
};

const waitForTaskCompletion = async (
  ctx: Parameters<typeof getPlatformState>[0],
  taskId: string,
  timeoutMs: number,
): Promise<"ready" | "timeout"> => {
  const shellTask = await waitForBackgroundShellTask(ctx.runContext.state.runId, taskId, timeoutMs);
  if (shellTask) {
    return "ready";
  }
  const agentTask = await waitForBackgroundAgentTask(ctx.runContext.state.runId, taskId, timeoutMs);
  if (agentTask) {
    return "ready";
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isTaskReady(ctx, taskId)) {
      return "ready";
    }
    await delay(100);
  }
  return (await isTaskReady(ctx, taskId)) ? "ready" : "timeout";
};

const getNextTaskId = (tasks: Record<string, { id: string }>): string => {
  const numericIds = Object.keys(tasks)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value));
  return String((numericIds.length > 0 ? Math.max(...numericIds) : 0) + 1);
};

export const createTaskCreateTool = (): AgentTool => {
  const schema = z.object({
    subject: z.string().min(1),
    description: z.string().min(1),
    activeForm: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });

  return {
    name: "TaskCreate",
    description: TASK_CREATE_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["collaboration", "task"],
      sandboxExpectation: "read-only",
      auditCategory: "collaboration",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const nextId = getNextTaskId(getPlatformState(ctx).tasks);
      return okToolResult(`Created task ${nextId}.`, {
        statePatch: buildPlatformPatch(ctx, (state) => ({
          ...state,
          tasks: {
            ...state.tasks,
            [nextId]: {
              id: nextId,
              subject: parsed.subject,
              description: parsed.description,
              ...(parsed.activeForm ? { activeForm: parsed.activeForm } : {}),
              ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
              status: "pending",
              blocks: [],
              blockedBy: [],
              updatedAt: nowIso(),
            },
          },
        })),
        structured: { task: { id: nextId, subject: parsed.subject } },
      });
    },
  };
};

export const createTaskUpdateTool = (): AgentTool => {
  const schema = z.object({
    taskId: z.string().min(1),
    subject: z.string().optional(),
    description: z.string().optional(),
    activeForm: z.string().optional(),
    status: taskStatusSchema.or(z.literal("deleted")).optional(),
    owner: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    addBlocks: z.array(z.string()).optional(),
    addBlockedBy: z.array(z.string()).optional(),
  });

  return {
    name: "TaskUpdate",
    description: TASK_UPDATE_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["collaboration", "task"],
      sandboxExpectation: "read-only",
      auditCategory: "collaboration",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const existing = getPlatformState(ctx).tasks[parsed.taskId];
      if (!existing) throw new Error(`Task not found: ${parsed.taskId}`);
      if (parsed.status === "deleted") {
        return okToolResult(`Deleted task ${parsed.taskId}.`, {
          statePatch: buildPlatformPatch(ctx, (state) => {
            const tasks = { ...state.tasks };
            delete tasks[parsed.taskId];
            return { ...state, tasks };
          }),
          structured: { success: true, taskId: parsed.taskId, updatedFields: ["deleted"] },
        });
      }

      const nextStatus = parsed.status;

      return okToolResult(`Updated task ${parsed.taskId}.`, {
        statePatch: buildPlatformPatch(ctx, (state) => ({
          ...state,
          tasks: {
            ...state.tasks,
            [parsed.taskId]: {
              ...existing,
              ...(parsed.subject !== undefined ? { subject: parsed.subject } : {}),
              ...(parsed.description !== undefined ? { description: parsed.description } : {}),
              ...(parsed.activeForm !== undefined ? { activeForm: parsed.activeForm } : {}),
              ...(nextStatus ? { status: nextStatus } : {}),
              ...(parsed.owner !== undefined ? { owner: parsed.owner } : {}),
              ...(parsed.metadata
                ? {
                    metadata: {
                      ...(existing.metadata ?? {}),
                      ...parsed.metadata,
                    },
                  }
                : {}),
              ...(parsed.addBlocks
                ? { blocks: [...new Set([...(existing.blocks ?? []), ...parsed.addBlocks])] }
                : {}),
              ...(parsed.addBlockedBy
                ? {
                    blockedBy: [
                      ...new Set([...(existing.blockedBy ?? []), ...parsed.addBlockedBy]),
                    ],
                  }
                : {}),
              updatedAt: nowIso(),
            },
          },
        })),
        structured: {
          success: true,
          taskId: parsed.taskId,
          updatedFields: Object.keys(parsed).filter((key) => key !== "taskId"),
        },
      });
    },
  };
};

export const createTaskOutputTool = (): AgentTool => {
  const schema = z.object({
    task_id: z.string().min(1),
    block: z.boolean().default(true),
    timeout: z.number().min(0).max(600_000).default(30_000),
  });

  return {
    name: "TaskOutput",
    description: TASK_OUTPUT_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["collaboration", "task"],
      sandboxExpectation: "read-only",
      auditCategory: "collaboration",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const currentTask = await getTaskOutputData(ctx, parsed.task_id);
      if (!parsed.block) {
        const retrieval_status = (await isTaskReady(ctx, parsed.task_id)) ? "success" : "not_ready";
        const structured = {
          retrieval_status,
          task: currentTask,
        } as const;
        return okToolResult(JSON.stringify(structured, null, 2), {
          structured,
        });
      }

      const status = await waitForTaskCompletion(ctx, parsed.task_id, parsed.timeout);
      const structured = {
        retrieval_status: status === "ready" ? "success" : "timeout",
        task: await getTaskOutputData(ctx, parsed.task_id),
      } as const;
      return okToolResult(JSON.stringify(structured, null, 2), {
        structured,
      });
    },
  };
};

export const createTaskGetTool = (): AgentTool => {
  const schema = z.object({
    taskId: z.string().min(1),
  });

  return {
    name: "TaskGet",
    description: TASK_GET_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["collaboration", "task"],
      sandboxExpectation: "read-only",
      auditCategory: "collaboration",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const task = getPlatformState(ctx).tasks[parsed.taskId];
      if (!task) throw new Error(`Task not found: ${parsed.taskId}`);
      return okToolResult(JSON.stringify(task, null, 2), { structured: { task } });
    },
  };
};

export const createTaskListTool = (): AgentTool => {
  const schema = z.object({});

  return {
    name: "TaskList",
    description: TASK_LIST_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["collaboration", "task"],
      sandboxExpectation: "read-only",
      auditCategory: "collaboration",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx) => {
      schema.parse(input);
      const tasks = Object.values(getPlatformState(ctx).tasks);
      return okToolResult(
        tasks.map((task) => `${task.id}: ${task.subject} [${task.status}]`).join("\n"),
        {
          structured: { tasks },
        },
      );
    },
  };
};

export const createTaskStopTool = (): AgentTool => {
  const schema = z.object({
    task_id: z.string().min(1),
  });

  return {
    name: "TaskStop",
    description: TASK_STOP_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["collaboration", "task"],
      sandboxExpectation: "read-only",
      auditCategory: "collaboration",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const platformState = getPlatformState(ctx);
      const shellTask = platformState.shellCommands[parsed.task_id];
      const agentTask = findAgentTaskRecord(platformState, parsed.task_id);

      if (shellTask) {
        if (shellTask.status !== "running") {
          throw new Error(`Task ${parsed.task_id} is not running.`);
        }
        await markBackgroundTaskCancelled(ctx.runContext.state.runId, parsed.task_id);
        return okToolResult(`Stopped task ${parsed.task_id}.`, {
          statePatch: buildPlatformPatch(ctx, (state) => ({
            ...state,
            shellCommands: {
              ...state.shellCommands,
              [parsed.task_id]: {
                ...shellTask,
                status: "cancelled",
                finishedAt: nowIso(),
              },
            },
          })),
          structured: {
            message: "Stopped background shell task.",
            task_id: parsed.task_id,
            task_type: "shell",
          },
        });
      }

      if (agentTask) {
        if (agentTask.status !== "running") {
          throw new Error(`Task ${parsed.task_id} is not running.`);
        }
        await markBackgroundTaskCancelled(ctx.runContext.state.runId, parsed.task_id);
        return okToolResult(`Stopped task ${parsed.task_id}.`, {
          statePatch: buildPlatformPatch(ctx, (state) => ({
            ...state,
            agents: {
              ...state.agents,
              [agentTask.id]: {
                ...agentTask,
                status: "cancelled",
                updatedAt: nowIso(),
              },
            },
          })),
          structured: {
            message: "Stopped background agent task.",
            task_id: parsed.task_id,
            task_type: "agent",
          },
        });
      }

      throw new Error(`Task not found: ${parsed.task_id}`);
    },
  };
};
