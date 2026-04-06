/**
 * @renx/agent 个人助理桌面 Agent Demo（BaseAgent v3）
 *
 * 能力：
 * - 日常问答 + 任务分解
 * - 操作电脑（打开应用、打开网页、输入文本、快捷键、截图）
 * - bash 命令执行（受安全策略约束）
 * - 流式输出、会话记忆、交互式 CLI
 */

import { createMiniMaxProvider, createModelClient } from "@renx/provider";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  AgentBase,
  DefaultBackendResolver,
  LocalBackend,
  InMemoryTimelineStore,
  type AgentInput,
  type AgentResult,
  type AgentRunContext,
  type AgentState,
  type AgentStreamEvent,
  type AgentTool,
  type PolicyEngine,
  type ApprovalEngine,
  type ApprovalTicket,
  type ApprovalDecision,
} from "@renx/agent";
import type { ToolResult } from "@renx/agent";
import { z } from "zod";
import { createOpenAIProvider } from "@renx/provider";
import { createOpenRouterProvider } from "@renx/provider";

const execFileAsync = promisify(execFile);

/**
 * 非「主线程」标识时，{@link RuntimeContextService} 不会附加 Claude 风格的 `context_management`。
 * MiniMax OpenAI 兼容接口遇到该字段常报 2013 invalid chat setting。
 */
const MINIMAX_DEMO_QUERY_SOURCE = "desktop_demo_peripheral";

const IS_MAC = os.platform() === "darwin";
const MAX_TOOL_OUTPUT_CHARS = 20_000;
const DEFAULT_HARD_DENY_PATTERNS: RegExp[] = [
  /\bmkfs\b/i,
  /\bdd\s+if=.*\bof=\/dev\/(sd|disk|rdisk)/i,
  />\s*\/dev\/(sd|disk|rdisk)/i,
];
const DEFAULT_REQUIRE_APPROVAL_PATTERNS: RegExp[] = [
  /\bsudo\b/i,
  /\brm\s+-rf\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkillall\b/i,
];
const HARD_DENY_PATTERNS = resolveCommandPatterns(
  process.env["DESKTOP_AGENT_HARD_DENY_PATTERNS"],
  DEFAULT_HARD_DENY_PATTERNS,
);
const REQUIRE_APPROVAL_PATTERNS = resolveCommandPatterns(
  process.env["DESKTOP_AGENT_REQUIRE_APPROVAL_PATTERNS"],
  DEFAULT_REQUIRE_APPROVAL_PATTERNS,
);

let CLI_VERBOSE = false;
let conversationMessages: AgentInput["messages"] = [];

interface StandardToolError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

interface StandardToolEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: StandardToolError;
}

function toolOk<T>(data: T, message?: string): ToolResult {
  const envelope: StandardToolEnvelope<T> = { ok: true, data };
  return {
    content: message ?? JSON.stringify(envelope),
    structured: envelope,
    metadata: { ok: true },
  };
}

function toolError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  retryable?: boolean,
): ToolResult {
  const envelope: StandardToolEnvelope = {
    ok: false,
    error: {
      code,
      message,
      ...(retryable !== undefined ? { retryable } : {}),
      ...(details ? { details } : {}),
    },
  };
  return {
    content: JSON.stringify(envelope),
    structured: envelope,
    metadata: { ok: false, errorCode: code },
  };
}

function truncate(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  return text.length > max
    ? `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`
    : text;
}

function resolveCommandPatterns(raw: string | undefined, fallback: RegExp[]): RegExp[] {
  if (!raw || raw.trim().length === 0) return fallback;
  const parsed: RegExp[] = [];
  for (const token of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      parsed.push(new RegExp(token, "i"));
    } catch {
      // Ignore invalid regex fragments from env.
    }
  }
  return parsed.length > 0 ? parsed : fallback;
}

function escapeAppleScriptText(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function ensureMacTool(toolName: string): ToolResult | undefined {
  if (IS_MAC) return undefined;
  return toolError("UNSUPPORTED_PLATFORM", `${toolName} 仅支持 macOS，当前系统是 ${os.platform()}`);
}

async function runAppleScript(script: string): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execFileAsync("osascript", ["-e", script], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { content: out || "ok" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: `AppleScript 执行失败: ${message}` };
  }
}

const openApplicationTool: AgentTool = {
  name: "open_application",
  description: "打开本机应用，例如 Safari、Terminal、Notes、VS Code",
  schema: z.object({
    app: z.string().min(1).optional().describe("应用名称，例如 Safari"),
    application: z.string().min(1).optional().describe("app 的别名，兼容字段"),
  }),
  isReadOnly: () => false,
  invoke: async (input): Promise<ToolResult> => {
    const unsupported = ensureMacTool("open_application");
    if (unsupported) return unsupported;

    const normalized = input as { app?: string; application?: string };
    const app = normalized.app ?? normalized.application;
    if (!app) {
      return toolError("INVALID_INPUT", "缺少应用名称，请提供 app 或 application", {
        acceptedFields: ["app", "application"],
      });
    }
    try {
      await execFileAsync("open", ["-a", app], { timeout: 20_000, maxBuffer: 512 * 1024 });
      return toolOk({ app, opened: true }, `已尝试打开应用: ${app}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError("OPEN_APP_FAILED", `打开应用失败: ${message}`, { app });
    }
  },
};

const openUrlTool: AgentTool = {
  name: "open_url",
  description: "在默认浏览器中打开网页",
  schema: z.object({
    url: z.string().optional().describe("完整 URL，例如 https://www.google.com"),
  }),
  isReadOnly: () => false,
  invoke: async (input): Promise<ToolResult> => {
    const unsupported = ensureMacTool("open_url");
    if (unsupported) return unsupported;

    const { url } = input as { url?: string };
    if (!url) {
      return toolError("INVALID_INPUT", "缺少 URL，请提供 url 字段");
    }
    const parsed = z.string().url().safeParse(url);
    if (!parsed.success) {
      return toolError("INVALID_INPUT", "URL 格式不合法", { url });
    }
    try {
      await execFileAsync("open", [url], { timeout: 20_000, maxBuffer: 512 * 1024 });
      return toolOk({ url, opened: true }, `已在浏览器打开: ${url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError("OPEN_URL_FAILED", `打开 URL 失败: ${message}`, { url });
    }
  },
};

const typeTextTool: AgentTool = {
  name: "type_text",
  description: "向当前活动窗口输入文本；可选先激活指定应用",
  schema: z.object({
    text: z.string().optional(),
    app: z.string().min(1).optional().describe("可选：先激活此应用再输入"),
    application: z.string().min(1).optional().describe("app 的别名，兼容字段"),
  }),
  isReadOnly: () => false,
  invoke: async (input): Promise<ToolResult> => {
    const unsupported = ensureMacTool("type_text");
    if (unsupported) return unsupported;

    const { text, app, application } = input as {
      text?: string;
      app?: string;
      application?: string;
    };
    if (!text || text.trim().length === 0) {
      return toolError("INVALID_INPUT", "缺少 text，或 text 为空");
    }
    if (text.length > 2000) {
      return toolError("INVALID_INPUT", "text 过长，最大 2000 字符", { length: text.length });
    }
    const targetApp = app ?? application;
    const escapedText = escapeAppleScriptText(text);
    const activateScript = targetApp
      ? `tell application "${escapeAppleScriptText(targetApp)}" to activate\n delay 0.3\n`
      : "";
    const script = `${activateScript}tell application "System Events" to keystroke "${escapedText}"`;
    const result = await runAppleScript(script);
    return result.content.startsWith("AppleScript 执行失败:")
      ? toolError("TYPE_TEXT_FAILED", result.content, { app: targetApp })
      : toolOk({ typed: true, app: targetApp ?? null }, result.content);
  },
};

const pressShortcutTool: AgentTool = {
  name: "press_shortcut",
  description: "模拟键盘快捷键，例如 command+l、command+v、command+shift+4",
  schema: z.object({
    key: z.string().optional().describe("单个按键字符，例如 l"),
    modifiers: z
      .array(z.enum(["command", "option", "control", "shift"]))
      .min(1)
      .max(4)
      .optional(),
  }),
  isReadOnly: () => false,
  invoke: async (input): Promise<ToolResult> => {
    const unsupported = ensureMacTool("press_shortcut");
    if (unsupported) return unsupported;

    const { key, modifiers } = input as {
      key?: string;
      modifiers?: Array<"command" | "option" | "control" | "shift">;
    };
    if (!key || key.length !== 1) {
      return toolError("INVALID_INPUT", "key 必须是单个字符");
    }
    const finalModifiers = modifiers && modifiers.length > 0 ? modifiers : ["command"];
    const modifierExpr = finalModifiers.map((m) => `${m} down`).join(", ");
    const script = `tell application "System Events" to keystroke "${escapeAppleScriptText(key)}" using {${modifierExpr}}`;
    const result = await runAppleScript(script);
    return result.content.startsWith("AppleScript 执行失败:")
      ? toolError("PRESS_SHORTCUT_FAILED", result.content, { key, modifiers: finalModifiers })
      : toolOk({ key, modifiers: finalModifiers }, result.content);
  },
};

const screenshotTool: AgentTool = {
  name: "take_screenshot",
  description: "截取当前屏幕并保存为 PNG 文件",
  schema: z.object({
    saveTo: z
      .string()
      .min(1)
      .optional()
      .describe("可选保存路径，默认 ~/Desktop/assistant-shot-<timestamp>.png"),
  }),
  isReadOnly: () => false,
  invoke: async (input): Promise<ToolResult> => {
    const unsupported = ensureMacTool("take_screenshot");
    if (unsupported) return unsupported;

    const { saveTo } = input as { saveTo?: string };
    const finalPath =
      saveTo ??
      path.join(
        process.env["HOME"] ?? process.cwd(),
        "Desktop",
        `assistant-shot-${new Date().toISOString().replaceAll(":", "-")}.png`,
      );
    try {
      await execFileAsync("screencapture", ["-x", finalPath], {
        timeout: 20_000,
        maxBuffer: 512 * 1024,
      });
      return toolOk({ path: finalPath }, `截图已保存: ${finalPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError("SCREENSHOT_FAILED", `截图失败: ${message}`, { path: finalPath });
    }
  },
};

const bashTool: AgentTool = {
  name: "bash",
  description: "执行本机 shell 命令，适合搜索文件、读取信息、运行脚本",
  schema: z.object({
    command: z.string().optional(),
    cwd: z.string().optional(),
    timeoutMs: z.number().optional(),
  }),
  isReadOnly: (input: unknown) => {
    const command = String((input as { command?: unknown })?.command ?? "").trim();
    return /^(ls|pwd|whoami|cat|head|tail|rg|find|echo|stat)\b/i.test(command);
  },
  invoke: async (input, ctx): Promise<ToolResult> => {
    const parsed = z
      .object({
        command: z.string().min(1),
        cwd: z.string().min(1).optional(),
        timeoutMs: z.number().int().positive().max(300_000).optional(),
      })
      .safeParse(input);
    if (!parsed.success) {
      return toolError("INVALID_INPUT", `bash 参数不合法: ${parsed.error.message}`);
    }
    if (!ctx.backend?.exec) {
      return toolError("BACKEND_UNAVAILABLE", "当前未配置可执行命令的 backend");
    }

    const { command, cwd, timeoutMs } = parsed.data;
    const result = await ctx.backend.exec(command, {
      ...(cwd ? { cwd } : {}),
      timeoutMs: timeoutMs ?? 90_000,
    });
    const rawContent = [
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
      `exit_code: ${result.exitCode}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return toolOk(
      {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      truncate(rawContent),
    );
  },
};

const desktopTools: AgentTool[] = [
  bashTool,
  openApplicationTool,
  openUrlTool,
  typeTextTool,
  pressShortcutTool,
  screenshotTool,
];

class DesktopSafetyPolicy implements PolicyEngine {
  async filterTools(_ctx: AgentRunContext, tools: AgentTool[]): Promise<AgentTool[]> {
    return tools;
  }

  async canUseTool(_ctx: AgentRunContext, tool: AgentTool, input: unknown): Promise<boolean> {
    if (tool.name !== "bash") return true;
    const command = String((input as { command?: unknown })?.command ?? "").trim();
    if (!command) return true;
    // 仅拦截硬红线；可协商风险交给 approval 流程
    return !HARD_DENY_PATTERNS.some((pattern) => pattern.test(command));
  }

  async redactOutput(_ctx: AgentRunContext, output: string): Promise<string> {
    return output
      .replaceAll(/sk-[a-zA-Z0-9_-]{16,}/g, "sk-***REDACTED***")
      .replaceAll(/MINIMAX_API_KEY\s*=\s*[^\s]+/g, "MINIMAX_API_KEY=***REDACTED***")
      .replaceAll(/OPENROUTER_API_KEY\s*=\s*[^\s]+/g, "OPENROUTER_API_KEY=***REDACTED***");
  }
}

interface CliPendingApproval {
  ticket: ApprovalTicket;
}

class CliApprovalEngine implements ApprovalEngine {
  private readonly decisions = new Map<string, ApprovalDecision>();

  evaluate(_ctx: AgentRunContext, tool: AgentTool, input: unknown) {
    if (tool.name !== "bash") return { required: false };
    const command = String((input as { command?: unknown })?.command ?? "").trim();
    if (!command) return { required: false };
    const dangerous = REQUIRE_APPROVAL_PATTERNS.some((pattern) => pattern.test(command));
    if (!dangerous) return { required: false };
    return {
      required: true,
      reason: `高风险命令需要确认: ${command}`,
      metadata: { command },
    };
  }

  request(_ctx: AgentRunContext, ticket: ApprovalTicket) {
    this.decisions.set(ticket.id, { ticketId: ticket.id, status: "pending" });
  }

  getDecision(_ctx: AgentRunContext, ticketId: string): ApprovalDecision | null {
    return this.decisions.get(ticketId) ?? null;
  }

  decide(ticketId: string, status: "approved" | "rejected", comment?: string) {
    this.decisions.set(ticketId, {
      ticketId,
      status,
      reviewerId: "local-cli-user",
      decidedAt: new Date().toISOString(),
      ...(comment ? { comment } : {}),
    });
  }
}

class PersonalDesktopAssistantAgent extends AgentBase {
  constructor(
    private readonly modelClient: ReturnType<typeof createModelClient>,
    private readonly modelName: string,
    private readonly approvalEngine: CliApprovalEngine,
    private readonly timeline = new InMemoryTimelineStore(),
  ) {
    super();
  }

  protected getName() {
    return "personal-desktop-assistant";
  }

  protected getSystemPrompt(_ctx: AgentRunContext) {
    return [
      "你是一个可执行电脑操作的个人助理。",
      "优先做法：先确认意图，再调用最合适的工具执行，最后简洁汇报执行结果。",
      "当用户请求包含打开/搜索/执行/输入/截图等可执行动作时，必须先调用至少一个工具，再给最终答复。",
      "可用工具包括：bash、open_application、open_url、type_text、press_shortcut、take_screenshot。",
      "参数约定：open_application 使用 {app}（也兼容 {application}）；open_url 使用 {url}。",
      "安全约束：硬红线命令直接拒绝；高风险命令（如 sudo、rm -rf、重启/关机）必须等待用户审批后才能执行。",
      "如果用户目标不清楚，先提一个澄清问题；如果明确，则直接执行。",
      `当前系统：${IS_MAC ? "macOS" : os.platform()}`,
    ].join("\n");
  }

  protected getTools(_ctx: AgentRunContext) {
    return desktopTools;
  }

  protected getModelClient() {
    return this.modelClient;
  }

  protected getModelName() {
    return this.modelName;
  }

  protected getPolicy() {
    return new DesktopSafetyPolicy();
  }

  protected getApprovalEngine() {
    return this.approvalEngine;
  }

  protected getBackendResolver() {
    const local = new LocalBackend();
    return new DefaultBackendResolver(local, local);
  }

  protected getTimelineStore() {
    return this.timeline;
  }

  protected getMaxSteps() {
    return 100000;
  }

  protected override async createResumeContext(record: {
    runId: string;
    state: AgentState;
  }): Promise<AgentRunContext> {
    const ctx = await super.createResumeContext(record);
    return {
      ...ctx,
      metadata: {
        ...ctx.metadata,
        querySource: MINIMAX_DEMO_QUERY_SOURCE,
      },
    };
  }
}

interface CliOptions {
  prompt?: string;
  verbose: boolean;
  showHelp: boolean;
}

function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = { verbose: false, showHelp: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.showHelp = true;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
      continue;
    }
    if (arg === "--prompt" || arg === "-p") {
      const value = args[i + 1];
      if (!value) throw new Error("参数 --prompt 需要一个值");
      options.prompt = value;
      i++;
      continue;
    }
  }
  return options;
}

function printUsage() {
  console.log("用法:");
  console.log('  pnpm --filter @renx/app demo:streaming [--prompt "任务"] [--verbose]');
  console.log("");
  console.log("参数:");
  console.log("  -p, --prompt   单次执行模式");
  console.log("  -v, --verbose  显示完整事件日志");
  console.log("  -h, --help     显示帮助");
  console.log("");
  console.log("交互命令:");
  console.log("  /help   查看帮助");
  console.log("  /clear  清空会话上下文");
  console.log("  /exit   退出");
}

function printBanner() {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              Personal Desktop Assistant Demo                ║");
  console.log("║   可执行本机操作：开应用 / 开网页 / 输入 / 快捷键 / 截图      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
}

function printEvent(event: AgentStreamEvent): void {
  if (event.type === "assistant_delta") {
    process.stdout.write(event.text);
    return;
  }

  if (!CLI_VERBOSE) {
    if (event.type === "tool_call") {
      console.log(`\n🔧 调用工具 ${event.call.name}(${JSON.stringify(event.call.input)})`);
    } else if (event.type === "tool_result") {
      console.log(`📦 ${truncate(event.result.content, 600)}`);
    } else if (event.type === "run_failed") {
      console.log(`\n💥 运行失败: ${event.error.code} - ${event.error.message}`);
    }
    return;
  }

  switch (event.type) {
    case "run_started":
      console.log(`\n🚀 run_started: ${event.runId}`);
      break;
    case "model_started":
      console.log("🤖 model_started");
      break;
    case "tool_call":
      console.log(`\n🔧 tool_call: ${event.call.name}(${JSON.stringify(event.call.input)})`);
      break;
    case "tool_result":
      console.log(`📦 tool_result: ${truncate(event.result.content, 1000)}`);
      break;
    case "run_completed":
      console.log("\n🏁 run_completed");
      break;
    case "run_failed":
      console.log(`\n💥 run_failed: ${event.error.code} - ${event.error.message}`);
      break;
    default:
      break;
  }
}

function sanitizeConversationHistory(messages: AgentInput["messages"]): AgentInput["messages"] {
  if (!messages || messages.length === 0) return [];
  // MiniMax：多条 role=system（与顶栏 systemPrompt 叠加）易触发 2013；历史里不要留 system。
  const allowed = messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "tool",
  );
  const seen = new Set<string>();
  const deduped: AgentInput["messages"] = [];
  for (const message of allowed) {
    const key = String(
      (message as { messageId?: string }).messageId ??
        `${message.role}:${message.id ?? message.createdAt ?? ""}`,
    );
    if (seen.has(key)) continue;
    seen.add(key);

    if (message.role === "assistant" && typeof message.content === "string") {
      const cleaned = stripThinkBlocks(message.content);
      deduped.push(cleaned === message.content ? message : { ...message, content: cleaned });
      continue;
    }
    deduped.push(message);
  }
  return deduped;
}

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trimStart();
}

async function runOnce(
  agent: PersonalDesktopAssistantAgent,
  prompt: string,
  history: AgentInput["messages"],
): Promise<AgentResult> {
  const sanitizedHistory = sanitizeConversationHistory(history);
  const now = Date.now();
  const nextMessages = [
    ...(sanitizedHistory ?? []),
    {
      id: `user_${now}`,
      messageId: `msg_user_${now}`,
      role: "user" as const,
      content: prompt,
      createdAt: new Date().toISOString(),
      source: "input" as const,
    },
  ];
  const stream = agent.stream({
    messages: nextMessages,
    metadata: { querySource: MINIMAX_DEMO_QUERY_SOURCE },
  });

  while (true) {
    const next = await stream.next();
    if (next.done) return next.value;
    printEvent(next.value);
  }
}

function extractPendingApproval(result: AgentResult): CliPendingApproval | null {
  const raw = result.state.scratchpad["__pendingApproval"];
  if (!raw || typeof raw !== "object") return null;
  const ticket = (raw as { ticket?: unknown }).ticket;
  if (!ticket || typeof ticket !== "object") return null;
  const t = ticket as Record<string, unknown>;
  if (
    typeof t["id"] !== "string" ||
    typeof t["toolName"] !== "string" ||
    typeof t["runId"] !== "string" ||
    !("input" in t) ||
    typeof t["requestedAt"] !== "string"
  ) {
    return null;
  }
  return {
    ticket: {
      id: t["id"],
      runId: t["runId"],
      toolName: t["toolName"],
      input: t["input"],
      requestedAt: t["requestedAt"],
      ...(typeof t["reason"] === "string" ? { reason: t["reason"] } : {}),
      ...(typeof t["expiresAt"] === "string" ? { expiresAt: t["expiresAt"] } : {}),
      ...(typeof t["metadata"] === "object" && t["metadata"] !== null
        ? { metadata: t["metadata"] as Record<string, unknown> }
        : {}),
    },
  };
}

async function resolveApprovalsIfNeeded(
  agent: PersonalDesktopAssistantAgent,
  approvalEngine: CliApprovalEngine,
  result: AgentResult,
  rl: ReturnType<typeof createInterface>,
): Promise<AgentResult> {
  let current = result;
  while (current.status === "waiting_approval") {
    const pending = extractPendingApproval(current);
    if (!pending) {
      console.log("⚠️  当前处于等待审批，但未解析到审批票据。");
      return current;
    }
    const commandPreview = JSON.stringify(pending.ticket.input);
    console.log(`\n🔐 需要确认: ${pending.ticket.toolName}(${commandPreview})`);
    if (pending.ticket.reason) {
      console.log(`原因: ${pending.ticket.reason}`);
    }
    const answer = (await rl.question("是否批准执行？(y/n): ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      approvalEngine.decide(pending.ticket.id, "approved", "approved in local cli");
    } else {
      approvalEngine.decide(pending.ticket.id, "rejected", "rejected in local cli");
    }
    current = await agent.resume(current.runId);
  }
  return current;
}

async function runInteractive(
  agent: PersonalDesktopAssistantAgent,
  approvalEngine: CliApprovalEngine,
) {
  const rl = createInterface({ input, output });
  console.log("输入 /help 查看帮助，输入 /exit 退出。\n");

  while (true) {
    const answer = (await rl.question("> ")).trim();
    if (!answer) continue;

    if (answer === "/exit" || answer === "exit" || answer === "quit") {
      break;
    }
    if (answer === "/help") {
      printUsage();
      console.log("");
      continue;
    }
    if (answer === "/clear") {
      conversationMessages = [];
      console.log("会话已清空。\n");
      continue;
    }

    console.log("AI> ");
    let result = await runOnce(agent, answer, conversationMessages);
    result = await resolveApprovalsIfNeeded(agent, approvalEngine, result, rl);
    if (result.status === "completed") {
      conversationMessages = sanitizeConversationHistory(result.state.messages);
    } else {
      console.log(`\n⚠️  当前状态: ${result.status}`);
      if (result.error) {
        console.log(`⚠️  错误: ${result.error.code} - ${result.error.message}`);
      }
    }
    console.log("\n");
  }

  rl.close();
}

function createClientAndModel(): {
  client: ReturnType<typeof createModelClient>;
  modelName: string;
} {
  // const preferredModel = process.env["DESKTOP_AGENT_MODEL"];
  const openrouterApiKey = process.env["OPENROUTER_API_KEY"];
  if (openrouterApiKey) {
    return {
      client: createModelClient({
        providers: [
          createOpenRouterProvider({
            apiKey: openrouterApiKey,
          }),
        ],
        retry: { maxAttempts: 3, baseDelayMs: 1000 },
      }),
      modelName: "openrouter:qwen/qwen3.6-plus:free",
    };
  }

  throw new Error("请设置 MINIMAX_API_KEY");
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.showHelp) {
    printUsage();
    return;
  }

  CLI_VERBOSE = options.verbose;
  const { client, modelName } = createClientAndModel();
  const approvalEngine = new CliApprovalEngine();
  const agent = new PersonalDesktopAssistantAgent(client, modelName, approvalEngine);

  printBanner();

  if (options.prompt) {
    const rl = createInterface({ input, output });
    console.log(`你> ${options.prompt}`);
    console.log("AI> ");
    let result = await runOnce(agent, options.prompt, conversationMessages);
    result = await resolveApprovalsIfNeeded(agent, approvalEngine, result, rl);
    if (result.status === "completed") {
      conversationMessages = sanitizeConversationHistory(result.state.messages);
    }
    rl.close();
    console.log("\n");
    return;
  }

  await runInteractive(agent, approvalEngine);
}

main().catch((error: unknown) => {
  console.error("❌ Demo 执行失败:", error);
  process.exit(1);
});
