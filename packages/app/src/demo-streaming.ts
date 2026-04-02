/**
 * @renx/agent 流式输出 Demo（仅 bash 工具）
 *
 * 流式生命周期、中间件、策略、审计、Checkpoint；
 * 工具仅为 createBashTool，依赖 LocalBackend 在本机执行命令。
 */

import { createMiniMaxProvider, createModelClient } from "@renx/provider";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createBashTool } from "@renx/agent-tools";
import {
  AgentBase,
  DefaultBackendResolver,
  InMemoryCheckpointStore,
  LocalBackend,
  type AgentMiddleware,
  type AgentInput,
  type AgentResult,
  type AgentRunContext,
  type AgentTool,
  type AgentStreamEvent,
  type PolicyEngine,
  type AuditEvent,
  type AuditLogger,
} from "@renx/agent";
import os from "node:os";
let CLI_VERBOSE = false;

// ============================================================
// 工具：bash only
// ============================================================

const TOOLS: AgentTool[] = [createBashTool()];

// ============================================================
// 中间件：计时器 + 脱敏 + 重试建议
// ============================================================

const timingMiddleware: AgentMiddleware = {
  name: "timing",
  beforeModel(ctx, req) {
    ctx.state.scratchpad["_stepStartTime"] = Date.now();
    return req;
  },
  afterModel(ctx, resp) {
    if (!CLI_VERBOSE) return resp;
    const elapsed = Date.now() - ((ctx.state.scratchpad["_stepStartTime"] as number) || Date.now());
    console.log(`    ⏱  [MW:timing] 模型调用耗时 ${elapsed}ms, 响应类型=${resp.type}`);
    return resp;
  },
  afterTool(ctx, result) {
    if (!CLI_VERBOSE) return;
    const elapsed = Date.now() - ((ctx.state.scratchpad["_stepStartTime"] as number) || Date.now());
    console.log(`    ⏱  [MW:timing] 工具 ${result.tool.name} 完成，累计耗时 ${elapsed}ms`);
  },
  afterRun(ctx, result) {
    if (!CLI_VERBOSE) return;
    const totalSteps = result.state.stepCount;
    const msgCount = result.state.messages.length;
    console.log(
      `    ⏱  [MW:timing] 运行结束: ${totalSteps} 步, ${msgCount} 条消息, 状态=${result.status}`,
    );
  },
};

const sensitiveRedactMiddleware: AgentMiddleware = {
  name: "sensitive-redact",
  beforeModel(_ctx, req) {
    if (!CLI_VERBOSE) return req;
    // 演示：记录请求中的消息数量
    console.log(`    🔒 [MW:redact] 检查 ${req.messages.length} 条消息，未发现敏感信息`);
    return req;
  },
};

const retryAdviceMiddleware: AgentMiddleware = {
  name: "retry-advice",
  onError(ctx, error) {
    if (!CLI_VERBOSE) return;
    console.log(`    🔄 [MW:retry] 错误 ${error.code}: ${error.message}`);
    if (error.retryable) {
      console.log(`    🔄 [MW:retry] 建议重试 (retryable=true)`);
    }
  },
};

// ============================================================
// 策略引擎：动态工具白名单
// ============================================================

class DynamicPolicy implements PolicyEngine {
  private allowed: Set<string>;

  constructor(toolNames: string[]) {
    this.allowed = new Set(toolNames);
  }

  filterTools(_ctx: AgentRunContext, tools: AgentTool[]): AgentTool[] {
    const filtered = tools.filter((t) => this.allowed.has(t.name));
    if (CLI_VERBOSE) {
      console.log(
        `    🛡  [Policy] 工具过滤: ${tools.length} → ${filtered.length} (白名单: ${[...this.allowed].join(", ")})`,
      );
    }
    return filtered;
  }

  canUseTool(_ctx: AgentRunContext, tool: AgentTool, _input: unknown): boolean {
    const allowed = this.allowed.has(tool.name);
    if (!allowed && CLI_VERBOSE) {
      console.log(`    🛡  [Policy] 拒绝工具 ${tool.name}（不在白名单中）`);
    }
    return allowed;
  }
}

// ============================================================
// 自定义审计日志（带彩色 emoji 前缀）
// ============================================================

class RichAuditLogger implements AuditLogger {
  log(event: AuditEvent): void {
    if (!CLI_VERBOSE) return;
    const emoji: Record<string, string> = {
      run_started: "🚀",
      model_called: "🤖",
      model_returned: "📤",
      tool_called: "🔧",
      tool_succeeded: "✅",
      tool_failed: "❌",
      run_completed: "🏁",
      run_failed: "💥",
    };
    const icon = emoji[event.type] ?? "📝";
    const shortRunId = event.runId.slice(0, 12);
    console.log(
      `    ${icon} [Audit:${event.type}] run=${shortRunId}… ${JSON.stringify(event.payload)}`,
    );
  }
}

// ============================================================
// Agent 定义
// ============================================================

class StreamingBashAgent extends AgentBase {
  private modelClient;

  constructor(modelClient: ReturnType<typeof createModelClient>) {
    super();
    this.modelClient = modelClient;
  }

  protected getName() {
    return "streaming-bash-demo";
  }
  protected getSystemPrompt(_ctx: AgentRunContext) {
    return `你是开发助手，只能通过 bash 工具在用户本机执行命令（列表、搜索、构建、git 等）。
根据用户意图构造合适的命令；引用命令输出时要准确、简洁。系统：${os.platform() === "win32" ? "Windows" : "Unix"}`;
  }
  protected getTools() {
    return TOOLS;
  }
  protected getModelClient() {
    return this.modelClient;
  }
  protected getModelName() {
    return "minimax:MiniMax-M2.7-highspeed";
  }
  protected getMiddlewares() {
    return [timingMiddleware, sensitiveRedactMiddleware, retryAdviceMiddleware];
  }
  protected getPolicy() {
    return new DynamicPolicy(TOOLS.map((t) => t.name));
  }
  protected getBackendResolver() {
    const local = new LocalBackend();
    return new DefaultBackendResolver(local, local);
  }
  protected getCheckpointStore() {
    return new InMemoryCheckpointStore();
  }
  protected getAuditLogger() {
    return new RichAuditLogger() as AuditLogger;
  }
  protected getMaxSteps() {
    return 10;
  }
}

// ============================================================
// 流式事件可视化
// ============================================================

function getEventIcon(type: AgentStreamEvent["type"]): string {
  const icons: Record<string, string> = {
    run_started: "🚀",
    model_started: "🤖",
    assistant_delta: "💬",
    tool_call_delta: "📝",
    tool_call: "🔧",
    tool_result: "📦",
    run_completed: "🏁",
    run_failed: "💥",
  };
  return icons[type] ?? "❓";
}

function printEvent(event: AgentStreamEvent, idx: number): void {
  if (!CLI_VERBOSE) {
    switch (event.type) {
      case "assistant_delta":
        process.stdout.write(event.text);
        break;
      case "tool_call":
        console.log(`\n🔧 调用工具 ${event.call.name}(${JSON.stringify(event.call.input)})`);
        break;
      case "tool_result":
        console.log(`📦 工具返回 ${event.result.content}`);
        break;
      case "run_failed":
        console.log(
          `\n💥 运行失败：${event.error.code} - ${event.error.message}-${event.error.metadata}`,
        );
        break;
      default:
        break;
    }
    return;
  }

  const icon = getEventIcon(event.type);
  const tag = `[Event #${String(idx).padStart(2, "0")}]`;

  switch (event.type) {
    case "run_started":
      console.log(`\n  ${icon} ${tag} run_started — runId: ${event.runId.slice(0, 20)}…`);
      console.log(`  ${"─".repeat(60)}`);
      break;

    case "model_started":
      console.log(`  ${icon} ${tag} model_started — 正在调用大模型…\n`);
      break;

    case "assistant_delta": {
      // 逐 token 直接输出，不截断，展现真实流式效果
      process.stdout.write(event.text);
      break;
    }

    case "tool_call":
      console.log(
        `\n  ${icon} ${tag} tool_call — ${event.call.name}(${JSON.stringify(event.call.input)})`,
      );
      break;

    case "tool_result": {
      const content =
        event.result.content.length > 100
          ? event.result.content.slice(0, 100) + "…"
          : event.result.content;
      console.log(`  ${icon} ${tag} tool_result — ${content}`);
      break;
    }

    case "run_completed": {
      console.log("\n");
      console.log(`  ${"─".repeat(60)}`);
      console.log(`  ${icon} ${tag} run_completed`);
      break;
    }

    case "run_failed":
      console.log(`\n ${icon} ${tag} run_failed — ${event.error.code}: ${event.error.message}`);
      break;
  }
}

// ============================================================
// 主函数
// ============================================================

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
      if (!value) {
        throw new Error("参数 --prompt 需要一个内容值");
      }
      options.prompt = value;
      i++;
      continue;
    }
  }
  return options;
}

function printUsage() {
  console.log("用法:");
  console.log('  pnpm --filter @renx/app demo:streaming [--prompt "问题"] [--verbose]');
  console.log("");
  console.log("参数:");
  console.log("  -p, --prompt   单次执行模式，执行后退出");
  console.log("  -v, --verbose  显示完整事件与中间件日志");
  console.log("  -h, --help     显示帮助");
  console.log("");
  console.log("交互命令:");
  console.log("  /help   查看命令帮助");
  console.log("  /clear  清空会话上下文");
  console.log("  /exit   退出");
}

function printCliBanner() {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                @renx/agent Streaming CLI                    ║");
  console.log("║              输入问题即可流式执行 Agent                     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
}

async function runOnce(
  agent: StreamingBashAgent,
  prompt: string,
  conversationMessages: AgentInput["messages"],
): Promise<AgentResult> {
  let eventCount = 0;

  const stream = agent.stream({
    messages: [
      ...(conversationMessages ?? []),
      {
        id: `in_${Date.now()}`,
        messageId: `in_msg_${Date.now()}`,
        role: "user",
        content: prompt,
        createdAt: new Date().toISOString(),
        source: "input",
      },
    ],
  });

  while (true) {
    const step = await stream.next();
    if (step.done) {
      return step.value;
    }
    eventCount++;
    printEvent(step.value, eventCount);
  }
}
let conversationMessages: AgentInput["messages"] = [];
async function runInteractive(agent: StreamingBashAgent) {
  const rl = createInterface({ input, output });

  console.log("输入 /help 查看命令，输入 /exit 退出。\n");

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
      console.log("会话上下文已清空。\n");
      continue;
    }

    console.log("AI> ");
    const result = await runOnce(agent, answer, conversationMessages);
    if (result.status === "completed") {
      conversationMessages = result.state.messages;
    }
    console.log("\n");
  }

  rl.close();
}

async function main() {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.showHelp) {
    printUsage();
    return;
  }

  const apiKey = process.env["MINIMAX_API_KEY"];
  if (!apiKey) {
    console.error("❌ 请设置环境变量 MINIMAX_API_KEY");
    process.exit(1);
  }
  CLI_VERBOSE = options.verbose;
  printCliBanner();

  const modelClient = createModelClient({
    providers: [
      createMiniMaxProvider({ apiKey, timeoutMs: 120_000, baseURL: "https://api.minimaxi.com/v1" }),
    ],
    retry: { maxAttempts: 3, baseDelayMs: 1000 },
  });

  const agent = new StreamingBashAgent(modelClient);
  if (options.prompt) {
    console.log(`你> ${options.prompt}`);
    console.log("助手> ");
    await runOnce(agent, options.prompt, []);
    console.log("\n");
    return;
  }

  await runInteractive(agent);
}

main().catch((err: unknown) => {
  console.error("❌ Demo 执行出错:", err);
  process.exit(1);
});
