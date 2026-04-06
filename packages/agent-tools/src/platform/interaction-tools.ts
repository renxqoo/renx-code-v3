import type { AgentTool } from "@renx/agent";
import { createToolCapabilityProfile } from "@renx/agent";
import { z } from "zod";

import {
  buildPlatformPatch,
  getAgentRunnerProvider,
  getPlatformState,
  nowIso,
  okToolResult,
} from "./shared";

const SEND_MESSAGE_TOOL_PROMPT = `# SendMessage

Send a message to another agent.

\`\`\`json
{"to": "researcher", "summary": "assign task 1", "message": "start on task #1"}
\`\`\`

| \`to\` | |
|---|---|
| \`"researcher"\` | Teammate by name |
| \`"*"\` | Broadcast to all teammates - expensive (linear in team size), use only when everyone genuinely needs it |

Your plain text output is NOT visible to other agents - to communicate, you MUST call this tool. Messages from teammates are delivered automatically; you don't check an inbox. Refer to teammates by name, never by UUID.

## Protocol responses (legacy)

If you receive a JSON message with \`type: "shutdown_request"\` or \`type: "plan_approval_request"\`, respond with the matching \`_response\` type. Don't send structured JSON status messages - use TaskUpdate.`;

const ASK_USER_QUESTION_TOOL_PROMPT = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan.`;

export const createSendMessageTool = (): AgentTool => {
  const schema = z.object({
    to: z.string().min(1),
    summary: z.string().optional(),
    message: z.union([
      z.string().min(1),
      z.object({
        type: z.string(),
        request_id: z.string().optional(),
        approve: z.boolean().optional(),
        reason: z.string().optional(),
        feedback: z.string().optional(),
      }),
    ]),
  });
  return {
    name: "SendMessage",
    description: SEND_MESSAGE_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["collaboration", "messaging"],
      sandboxExpectation: "read-only",
      auditCategory: "collaboration",
    }),
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      const content =
        typeof parsed.message === "string" ? parsed.message : JSON.stringify(parsed.message);
      const runner = getAgentRunnerProvider(ctx);
      const existingAgent = getPlatformState(ctx).agents[parsed.to];
      if (existingAgent && typeof parsed.message === "string") {
        const providerResult = await runner?.sendMessage?.(parsed.to, {
          message: parsed.message,
          sharedContext: {},
        });
        return okToolResult(`Sent message to ${parsed.to}.`, {
          structured: {
            success: true,
            message: `Message sent to ${parsed.to}`,
            routing: {
              target: parsed.to,
              ...(parsed.summary ? { summary: parsed.summary } : {}),
              content,
            },
          },
          statePatch: buildPlatformPatch(ctx, (state) => ({
            ...state,
            messages: [
              ...state.messages,
              {
                id: `msg_${state.messages.length + 1}`,
                channel: parsed.to,
                content,
                createdAt: nowIso(),
              },
            ],
            agents: {
              ...state.agents,
              [parsed.to]: {
                ...existingAgent,
                ...(providerResult?.status ? { status: providerResult.status } : {}),
                ...(providerResult?.output !== undefined ? { output: providerResult.output } : {}),
                ...(providerResult?.outputFile ? { outputFile: providerResult.outputFile } : {}),
                messages: [
                  ...existingAgent.messages,
                  {
                    content,
                    createdAt: nowIso(),
                  },
                  ...(!providerResult?.transcript
                    ? []
                    : [{ content: providerResult.transcript, createdAt: nowIso() }]),
                ],
                sharedContext: {
                  ...existingAgent.sharedContext,
                  ...(providerResult?.sharedContext ?? {}),
                },
                updatedAt: nowIso(),
              },
            },
          })),
        });
      }
      return okToolResult(`Sent message to ${parsed.to}.`, {
        structured: {
          success: true,
          message: `Message sent to ${parsed.to}`,
          routing: {
            target: parsed.to,
            ...(parsed.summary ? { summary: parsed.summary } : {}),
            content,
          },
        },
        statePatch: buildPlatformPatch(ctx, (state) => ({
          ...state,
          messages: [
            ...state.messages,
            {
              id: `msg_${state.messages.length + 1}`,
              channel: parsed.to,
              content,
              createdAt: nowIso(),
            },
          ],
        })),
      });
    },
  };
};

export const createAskUserQuestionTool = (): AgentTool => {
  const schema = z.object({
    questions: z
      .array(
        z.object({
          question: z.string().min(1),
          header: z.string().min(1),
          options: z
            .array(
              z.object({
                label: z.string().min(1),
                description: z.string().min(1),
                preview: z.string().optional(),
              }),
            )
            .min(2)
            .max(4),
          multiSelect: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(4),
    answers: z.record(z.string(), z.string()).optional(),
    annotations: z
      .record(
        z.string(),
        z.object({ preview: z.string().optional(), notes: z.string().optional() }),
      )
      .optional(),
  });
  return {
    name: "AskUserQuestion",
    description: ASK_USER_QUESTION_TOOL_PROMPT,
    schema,
    profile: createToolCapabilityProfile({
      riskLevel: "low",
      capabilityTags: ["interaction"],
      sandboxExpectation: "read-only",
      auditCategory: "interaction",
    }),
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    invoke: async (input, ctx) => {
      const parsed = schema.parse(input);
      return okToolResult(
        parsed.answers
          ? `User has answered your questions: ${Object.entries(parsed.answers)
              .map(([question, answer]) => `"${question}"="${answer}"`)
              .join(", ")}.`
          : parsed.questions.map((question) => question.question).join("\n"),
        {
          structured: {
            questions: parsed.questions,
            answers: parsed.answers ?? {},
            ...(parsed.annotations ? { annotations: parsed.annotations } : {}),
          },
          statePatch: {
            ...buildPlatformPatch(ctx, (state) => ({
              ...state,
              questions: [
                ...state.questions,
                ...parsed.questions.map((question) => ({
                  question: question.question,
                  context: JSON.stringify(question),
                  askedAt: nowIso(),
                })),
              ],
            })),
            setStatus: "waiting_approval",
          },
        },
      );
    },
  };
};
