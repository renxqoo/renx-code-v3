import type { AgentTool } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import { buildPlatformPatch, okToolResult } from "./shared";

const TODO_WRITE_TOOL_PROMPT = `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool
Use this tool proactively in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done
5. After receiving new instructions - Immediately capture user requirements as todos
6. When you start working on a task - Mark it as in_progress BEFORE beginning work
7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

When in doubt, use this tool.`;

const BRIEF_TOOL_PROMPT = `Send a message the user will read. Text outside this tool is visible in the detail view, but most won't open it - the answer lives here.

\`message\` supports markdown. \`attachments\` takes file paths (absolute or cwd-relative) for images, diffs, logs.

\`status\` labels intent: 'normal' when replying to what they just asked; 'proactive' when you're initiating - a scheduled task finished, a blocker surfaced during background work, you need input on something they haven't asked about. Set it honestly; downstream routing uses it.`;

const ENTER_PLAN_MODE_TOOL_PROMPT = `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

Prefer using EnterPlanMode for implementation tasks unless they're simple. Use it when any of these conditions apply:
- New feature implementation
- Multiple valid approaches
- Code modifications that affect existing behavior or structure
- Architectural decisions
- Multi-file changes
- Unclear requirements
- User preferences materially affect the implementation

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research or exploration tasks`;

const EXIT_PLAN_MODE_TOOL_PROMPT = `Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first
- Once your plan is finalized, use THIS tool to request approval

Important: Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does.`;

export const createEnterPlanModeTool = (): AgentTool => {
  const schema = z.object({});
  return {
    name: "EnterPlanMode",
    description: ENTER_PLAN_MODE_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["planning"],
      sandboxExpectation: "read-only",
      auditCategory: "planning",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      schema.parse(input);
      const patch = buildPlatformPatch(ctx, (state) => ({
        ...state,
        planMode: { active: true },
      }));
      return okToolResult("Plan mode enabled.", { statePatch: patch });
    },
  };
};

export const createExitPlanModeTool = (): AgentTool => {
  const schema = z.object({
    allowedPrompts: z
      .array(
        z.object({
          tool: z.enum(["Bash"]),
          prompt: z.string().min(1),
        }),
      )
      .optional(),
  });
  return {
    name: "ExitPlanMode",
    description: EXIT_PLAN_MODE_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["planning"],
      sandboxExpectation: "read-only",
      auditCategory: "planning",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      schema.parse(input);
      return okToolResult("Plan mode disabled.", {
        statePatch: buildPlatformPatch(ctx, (state) => ({
          ...state,
          planMode: { active: false },
        })),
      });
    },
  };
};

export const createTodoWriteTool = (): AgentTool => {
  const schema = z.object({
    todos: z.array(
      z.object({
        id: z.string().min(1),
        content: z.string().min(1),
        status: z.enum(["pending", "in_progress", "completed", "blocked", "cancelled"]),
      }),
    ),
  });
  return {
    name: "TodoWrite",
    description: TODO_WRITE_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["planning", "todo"],
      sandboxExpectation: "read-only",
      auditCategory: "planning",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      return okToolResult(`Stored ${parsed.todos.length} todo item(s).`, {
        statePatch: buildPlatformPatch(ctx, (state) => ({
          ...state,
          todos: parsed.todos,
        })),
      });
    },
  };
};

export const createBriefTool = (): AgentTool => {
  const schema = z.object({
    message: z.string().min(1),
    attachments: z.array(z.string()).optional(),
    status: z.enum(["normal", "proactive"]),
  });
  return {
    name: "SendUserMessage",
    description: BRIEF_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["summary"],
      sandboxExpectation: "read-only",
      auditCategory: "summary",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      return okToolResult(parsed.message, {
        structured: {
          message: parsed.message,
          ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
          status: parsed.status,
        },
        statePatch: buildPlatformPatch(ctx, (state) => ({
          ...state,
          messages: [
            ...state.messages,
            {
              id: `user_msg_${state.messages.length + 1}`,
              channel: "user",
              content: parsed.message,
              createdAt: new Date().toISOString(),
            },
          ],
        })),
      });
    },
  };
};
