/**
 * @renx/agent 企业级 Agent SDK Demo
 *
 * 演示:
 *  1. 天气助手 — 带工具调用的 Agent（EnterpriseAgentBase 子类）
 *  2. 自定义中间件 — 日志中间件 + 审计中间件
 *  3. 自定义策略 — 工具白名单
 *  4. Checkpoint 恢复 — 中断后从检查点继续
 *  5. 直接使用 AgentRuntime（不通过 base class）
 */

import { createModelClient, createOpenRouterProvider } from "@renx/provider";
import {
  EnterpriseAgentBase,
  InMemoryCheckpointStore,
  ConsoleAuditLogger,
  AgentRuntime,
} from "@renx/agent";
import type {
  AgentMiddleware,
  AgentRunContext,
  AgentTool,
  PolicyEngine,
  ToolResult,
} from "@renx/agent";

// ============================================================
// 工具定义
// ============================================================

const getWeatherTool: AgentTool = {
  name: "get_weather",
  description: "获取指定城市的天气信息",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名称" },
    },
    required: ["city"],
  },
  invoke: async (input: unknown): Promise<ToolResult> => {
    const { city } = input as { city: string };
    // 模拟天气 API
    const weatherData: Record<string, { temp: string; desc: string }> = {
      北京: { temp: "18°C", desc: "晴朗" },
      上海: { temp: "22°C", desc: "多云" },
      深圳: { temp: "28°C", desc: "阵雨" },
      Tokyo: { temp: "15°C", desc: "Clear" },
    };
    const data = weatherData[city] ?? { temp: "20°C", desc: "Unknown" };
    return {
      content: JSON.stringify({ city, ...data }),
      metadata: { source: "mock-api" },
    };
  },
};

const getStockTool: AgentTool = {
  name: "get_stock_price",
  description: "获取股票价格",
  inputSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "股票代码" },
    },
    required: ["symbol"],
  },
  invoke: async (input: unknown): Promise<ToolResult> => {
    const { symbol } = input as { symbol: string };
    const price = (Math.random() * 200 + 50).toFixed(2);
    return {
      content: JSON.stringify({ symbol, price, currency: "USD" }),
    };
  },
};

const calculatorTool: AgentTool = {
  name: "calculator",
  description: "执行数学计算",
  inputSchema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "数学表达式，如 '2 + 3 * 4'" },
    },
    required: ["expression"],
  },
  invoke: async (input: unknown): Promise<ToolResult> => {
    const { expression } = input as { expression: string };
    try {
      // 简单安全：只允许数字和运算符
      if (!/^[\d\s+\-*/().]+$/.test(expression)) {
        return { content: "Error: invalid expression" };
      }
      const fn = new Function(`return (${expression})`);
      const result = fn();
      return { content: String(result) };
    } catch {
      return { content: "Error: calculation failed" };
    }
  },
};

// ============================================================
// 1. 天气助手 Agent（继承 EnterpriseAgentBase）
// ============================================================

class WeatherAgent extends EnterpriseAgentBase {
  private modelClient;

  constructor(modelClient: ReturnType<typeof createModelClient>) {
    super();
    this.modelClient = modelClient;
  }

  protected getName() {
    return "weather-agent";
  }

  protected getSystemPrompt(_ctx: AgentRunContext) {
    return "你是一个天气助手。使用 get_weather 工具查询天气，用中文回答。";
  }

  protected getTools(_ctx: AgentRunContext) {
    return [getWeatherTool];
  }

  protected getModelClient() {
    return this.modelClient;
  }
  protected getModelName() {
    return "openrouter:qwen/qwen3.6-plus-preview:free";
  }
}

// ============================================================
// 2. 多工具金融助手（带中间件 + 策略 + 审计 + Checkpoint）
// ============================================================

// --- 日志中间件 ---
const loggingMiddleware: AgentMiddleware = {
  name: "logging",
  beforeModel(ctx, req) {
    console.log(`  [MW] beforeModel: ${req.messages.length} messages, ${req.tools.length} tools`);
    return req;
  },
  afterModel(ctx, resp) {
    console.log(`  [MW] afterModel: response type = ${resp.type}`);
    return resp;
  },
  beforeTool(ctx, call) {
    console.log(`  [MW] beforeTool: ${call.name}(${JSON.stringify(call.input)})`);
    return undefined;
  },
  afterTool(ctx, result) {
    console.log(`  [MW] afterTool: ${result.tool.name} → ${result.output.content}`);
    return undefined;
  },
  onError(ctx, error) {
    console.log(`  [MW] onError: ${error.code} - ${error.message}`);
  },
  afterRun(ctx, result) {
    console.log(`  [MW] afterRun: status=${result.status}, steps=${result.state.stepCount}`);
  },
};

// --- 白名单策略 ---
class WhitelistPolicy implements PolicyEngine {
  private allowedTools: Set<string>;

  constructor(toolNames: string[]) {
    this.allowedTools = new Set(toolNames);
  }

  filterTools(_ctx: AgentRunContext, tools: AgentTool[]): AgentTool[] {
    return tools.filter((t) => this.allowedTools.has(t.name));
  }

  canUseTool(_ctx: AgentRunContext, tool: AgentTool, _input: unknown): boolean {
    return this.allowedTools.has(tool.name);
  }
}

class FinanceAgent extends EnterpriseAgentBase {
  private modelClient;
  private checkpointStore;
  private auditLogger;

  constructor(modelClient: ReturnType<typeof createModelClient>) {
    super();
    this.modelClient = modelClient;
    this.checkpointStore = new InMemoryCheckpointStore();
    this.auditLogger = new ConsoleAuditLogger();
  }

  protected getName() {
    return "finance-agent";
  }

  protected getSystemPrompt(_ctx: AgentRunContext) {
    return "你是一个金融助手。使用 get_stock_price 查询股价，使用 calculator 进行计算。用中文回答。";
  }

  protected getTools(_ctx: AgentRunContext) {
    return [getStockTool, calculatorTool];
  }

  protected getModelClient() {
    return this.modelClient;
  }
  protected getModelName() {
    return "openrouter:qwen/qwen3.6-plus-preview:free";
  }

  protected getMiddlewares() {
    return [loggingMiddleware];
  }
  protected getPolicy() {
    return new WhitelistPolicy(["get_stock_price", "calculator"]);
  }
  protected getCheckpointStore() {
    return this.checkpointStore;
  }
  protected getAuditLogger() {
    return this.auditLogger;
  }
  protected getMaxSteps() {
    return 8;
  }

  // 暴露 checkpoint 供 demo 使用
  getCheckpoint() {
    return this.checkpointStore;
  }
}

// ============================================================
// 5. 直接使用 AgentRuntime
// ============================================================

async function directRuntimeDemo(modelClient: ReturnType<typeof createModelClient>) {
  console.log("\n=== Demo 3: 直接使用 AgentRuntime ===\n");

  const tools: AgentTool[] = [getWeatherTool, calculatorTool];

  const runtime = new AgentRuntime({
    name: "direct-runtime",
    modelClient,
    model: "openrouter:qwen/qwen3.6-plus-preview:free",
    tools,
    systemPrompt: "你是一个助手。使用 get_weather 查天气，使用 calculator 做计算。用中文回答。",
    maxSteps: 5,
  });

  // 构建 context（直接使用 runtime.run 而非 base.invoke）
  const runId = crypto.randomUUID();
  const ctx: AgentRunContext = {
    input: { inputText: "北京天气怎么样？如果气温低于25度，计算 18 * 3 + 5" },
    identity: { userId: "demo-user", tenantId: "default", roles: [] },
    state: {
      runId,
      messages: [],
      scratchpad: {},
      memory: {},
      stepCount: 0,
      status: "running",
    },
    services: {},
    metadata: {},
  };

  const result = await runtime.run(ctx);

  console.log(`  状态: ${result.status}`);
  console.log(`  步数: ${result.state.stepCount}`);
  if (result.output) {
    console.log(`  回复: ${result.output.slice(0, 200)}`);
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const apiKey = process.env["OPENROUTER_API_KEY"];

  if (!apiKey) {
    console.error("请设置环境变量 OPENROUTER_API_KEY");
    console.error("  export OPENROUTER_API_KEY=sk-or-xxx");
    process.exit(1);
  }

  const modelClient = createModelClient({
    providers: [createOpenRouterProvider({ apiKey })],
    retry: { maxAttempts: 2, baseDelayMs: 500 },
  });

  // ---- Demo 1: 天气助手 ----
  console.log("=== Demo 1: 天气助手 (EnterpriseAgentBase) ===\n");

  const weatherAgent = new WeatherAgent(modelClient);
  const r1 = await weatherAgent.invoke({ inputText: "北京今天天气怎么样？" });
  console.log(`  状态: ${r1.status}`);
  if (r1.output) console.log(`  回复: ${r1.output.slice(0, 300)}`);
  console.log(`  消息数: ${r1.state.messages.length}`);

  // ---- Demo 2: 金融助手（带中间件 + 策略 + 审计 + Checkpoint）----
  console.log("\n=== Demo 2: 金融助手 (Middleware + Policy + Audit + Checkpoint) ===\n");

  const financeAgent = new FinanceAgent(modelClient);

  const r2 = await financeAgent.invoke({ inputText: "帮我查一下 AAPL 的股价" });
  console.log(`\n  状态: ${r2.status}`);
  if (r2.output) console.log(`  回复: ${r2.output.slice(0, 300)}`);

  // ---- Demo 3: 直接使用 Runtime ----
  await directRuntimeDemo(modelClient);

  console.log("\n=== Demo 完成 ===");
}

main().catch((error: unknown) => {
  console.error("Demo error:", error);
  process.exit(1);
});
