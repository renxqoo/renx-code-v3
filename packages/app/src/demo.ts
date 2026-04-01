/**
 * @renx/agent 企业级 Agent SDK Demo（v2）
 *
 * 4 个递进式场景，覆盖 SDK 所有核心能力：
 *  Demo 1 — 基础天气助手（EnterpriseAgentBase + invoke）
 *  Demo 2 — 流式金融助手（stream + 中间件 + 策略 + 审计 + Checkpoint）
 *  Demo 3 — 多工具并发 + 输入验证（ToolExecutor.runBatch + isConcurrencySafe + validateInput）
 *  Demo 4 — 直接使用 AgentRuntime（手动构建 context + runtime）
 */

import { createModelClient, createOpenRouterProvider } from "@renx/provider";
import {
  EnterpriseAgentBase,
  InMemoryCheckpointStore,
  ConsoleAuditLogger,
  AgentRuntime,
  InMemoryToolRegistry,
  MiddlewarePipeline,
  ToolExecutor,
  generateId,
} from "@renx/agent";
import type {
  AgentMiddleware,
  AgentRunContext,
  AgentTool,
  AgentState,
  AgentIdentity,
  AgentServices,
  AgentStreamEvent,
  PolicyEngine,
  ToolResult,
  ToolContext,
  ValidationResult,
} from "@renx/agent";

// ============================================================
// 工具定义
// ============================================================

/** 模拟天气查询 */
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

/** 模拟股价查询 */
const getStockPriceTool: AgentTool = {
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

/**
 * 安全的数学计算工具（不使用 new Function，用简单解析）
 *
 * 支持：加(+)、减(-)、乘(*)、除(/)、括号、小数
 */
const calculatorTool: AgentTool = {
  name: "calculator",
  description: "执行数学计算，支持加减乘除和括号",
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
      // 白名单校验：只允许数字、运算符、空格、小数点、括号
      if (!/^[\d\s+\-*/().]+$/.test(expression)) {
        return { content: `Error: expression contains invalid characters: "${expression}"` };
      }
      const result = safeEval(expression);
      return { content: String(result) };
    } catch {
      return { content: `Error: calculation failed for "${expression}"` };
    }
  },
};

/**
 * 翻译工具 — 标记为 concurrency-safe + readOnly + 带 validateInput
 */
const translateTool: AgentTool = {
  name: "translate",
  description: "将文本翻译为指定语言",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "要翻译的文本" },
      targetLang: { type: "string", description: "目标语言，如 en、zh、ja" },
    },
    required: ["text", "targetLang"],
  },
  isConcurrencySafe(_input: unknown): boolean {
    return true;
  },
  isReadOnly(_input: unknown): boolean {
    return true;
  },
  validateInput(input: unknown, _ctx: ToolContext): ValidationResult {
    const { text, targetLang } = input as { text?: string; targetLang?: string };
    if (!text || text.trim().length === 0) {
      return { result: false, message: "text must be a non-empty string", code: "INVALID_TEXT" };
    }
    const supported = ["en", "zh", "ja", "ko", "fr", "de"];
    if (!targetLang || !supported.includes(targetLang)) {
      return {
        result: false,
        message: `targetLang must be one of: ${supported.join(", ")}`,
        code: "UNSUPPORTED_LANG",
      };
    }
    return { result: true };
  },
  invoke: async (input: unknown): Promise<ToolResult> => {
    const { text, targetLang } = input as { text: string; targetLang: string };
    // 模拟翻译
    const translations: Record<string, Record<string, string>> = {
      "en→zh": { hello: "你好", world: "世界" },
      "zh→en": { 你好: "Hello", 世界: "World" },
    };
    const key = `${targetLang}`;
    const lookup = translations[key] ?? {};
    const translated = lookup[text] ?? `[${targetLang}] ${text}`;
    return { content: translated, metadata: { translator: "mock" } };
  },
};

// ============================================================
// 简易数学表达式求值器（不使用 new Function / eval）
// ============================================================

function safeEval(expr: string): number {
  const tokens = tokenize(expr);
  let pos = 0;

  function parseExpr(): number {
    let result = parseTerm();
    while (pos < tokens.length && (tokens[pos] === "+" || tokens[pos] === "-")) {
      const op = tokens[pos++];
      const right = parseTerm();
      result = op === "+" ? result + right : result - right;
    }
    return result;
  }

  function parseTerm(): number {
    let result = parseFactor();
    while (pos < tokens.length && (tokens[pos] === "*" || tokens[pos] === "/")) {
      const op = tokens[pos++];
      const right = parseFactor();
      result = op === "*" ? result * right : result / right;
    }
    return result;
  }

  function parseFactor(): number {
    if (tokens[pos] === "(") {
      pos++; // skip '('
      const result = parseExpr();
      pos++; // skip ')'
      return result;
    }
    const numStr = tokens[pos++];
    return parseFloat(numStr!);
  }

  const result = parseExpr();
  return result;
}

function tokenize(expr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === " ") {
      i++;
      continue;
    }
    if ("+-*/()".includes(ch!)) {
      tokens.push(ch!);
      i++;
    } else {
      let num = "";
      while (i < expr.length && /[\d.]/.test(expr[i]!)) {
        num += expr[i];
        i++;
      }
      if (num) tokens.push(num);
    }
  }
  return tokens;
}

// ============================================================
// Demo 1: 基础天气助手（EnterpriseAgentBase + invoke）
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

async function demo1(client: ReturnType<typeof createModelClient>) {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Demo 1: 基础天气助手 — EnterpriseAgentBase + invoke()     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const agent = new WeatherAgent(client);
  const result = await agent.invoke({ inputText: "北京今天天气怎么样？" });

  console.log(`  状态: ${result.status}`);
  if (result.output) console.log(`  回复: ${result.output.slice(0, 300)}`);
  console.log(`  消息数: ${result.state.messages.length}`);
  console.log(`  步数: ${result.state.stepCount}\n`);
}

// ============================================================
// Demo 2: 流式金融助手（stream + 中间件 + 策略 + 审计 + Checkpoint）
// ============================================================

// --- 日志中间件 ---
const loggingMiddleware: AgentMiddleware = {
  name: "logging",
  beforeModel(_ctx, req) {
    console.log(
      `  [MW:logging] beforeModel — ${req.messages.length} messages, ${req.tools.length} tools`,
    );
    return req;
  },
  afterModel(_ctx, resp) {
    console.log(`  [MW:logging] afterModel — response type = ${resp.type}`);
    return resp;
  },
  beforeTool(_ctx, call) {
    console.log(`  [MW:logging] beforeTool — ${call.name}(${JSON.stringify(call.input)})`);
    return undefined;
  },
  afterTool(_ctx, result) {
    console.log(
      `  [MW:logging] afterTool — ${result.tool.name} → ${result.output.content.slice(0, 80)}`,
    );
    return undefined;
  },
  onError(_ctx, error) {
    console.log(`  [MW:logging] onError — ${error.code}: ${error.message}`);
  },
  afterRun(_ctx, result) {
    console.log(
      `  [MW:logging] afterRun — status=${result.status}, steps=${result.state.stepCount}`,
    );
  },
};

// --- 白名单策略 ---
class WhitelistPolicy implements PolicyEngine {
  private allowed: Set<string>;

  constructor(toolNames: string[]) {
    this.allowed = new Set(toolNames);
  }

  filterTools(_ctx: AgentRunContext, tools: AgentTool[]): AgentTool[] {
    return tools.filter((t) => this.allowed.has(t.name));
  }

  canUseTool(_ctx: AgentRunContext, tool: AgentTool, _input: unknown): boolean {
    return this.allowed.has(tool.name);
  }
}

class StreamingFinanceAgent extends EnterpriseAgentBase {
  private modelClient;

  constructor(modelClient: ReturnType<typeof createModelClient>) {
    super();
    this.modelClient = modelClient;
  }

  protected getName() {
    return "streaming-finance-agent";
  }
  protected getSystemPrompt(_ctx: AgentRunContext) {
    return "你是一个金融助手。使用 get_stock_price 查询股价，使用 calculator 做计算。用中文回答。";
  }
  protected getTools(_ctx: AgentRunContext) {
    return [getStockPriceTool, calculatorTool];
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
    return new InMemoryCheckpointStore();
  }
  protected getAuditLogger() {
    return new ConsoleAuditLogger();
  }
  protected getMaxSteps() {
    return 8;
  }
}

async function demo2(client: ReturnType<typeof createModelClient>) {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Demo 2: 流式金融助手 — stream() + MW + Policy + Audit    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const agent = new StreamingFinanceAgent(client);
  const stream = agent.stream({ inputText: "帮我查一下 AAPL 和 GOOGL 的股价" });

  // 逐事件打印流式生命周期
  for await (const event of stream) {
    printStreamEvent(event);
  }

  // stream() 的 return value（AgentResult）在 for-await-of 中不产出，
  // 可通过 run_completed 事件或再调 invoke 获取。此处用 invoke 拿完整结果：
  const result = await agent.invoke({ inputText: "帮我查一下 AAPL 和 GOOGL 的股价" });
  console.log(`\n  最终状态: ${result.status}`);
  if (result.output) console.log(`  最终回复: ${result.output.slice(0, 300)}`);
  console.log();
}

function printStreamEvent(event: AgentStreamEvent) {
  switch (event.type) {
    case "run_started":
      console.log(`  ▶ run_started  — runId: ${event.runId}`);
      break;
    case "model_started":
      console.log(`  ▶ model_started`);
      break;
    case "assistant_delta":
      console.log(`  ▶ assistant_delta — ${event.text.slice(0, 80)}`);
      break;
    case "tool_call":
      console.log(`  ▶ tool_call     — ${event.call.name}(${JSON.stringify(event.call.input)})`);
      break;
    case "tool_result":
      console.log(`  ▶ tool_result   — ${event.result.content.slice(0, 80)}`);
      break;
    case "approval_required":
      console.log(`  ▶ approval_required — requestId: ${event.requestId}`);
      break;
    case "run_completed":
      console.log(`  ▶ run_completed — output: ${event.output.slice(0, 80)}`);
      break;
    case "run_failed":
      console.log(`  ▶ run_failed    — ${event.error.code}: ${event.error.message}`);
      break;
  }
}

// ============================================================
// Demo 3: 多工具并发 + 输入验证（直接使用 ToolExecutor.runBatch）
// ============================================================

async function demo3() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Demo 3: 多工具并发 + 输入验证 — ToolExecutor.runBatch()  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // 构建 registry 并注册工具
  const registry = new InMemoryToolRegistry();
  registry.register(translateTool);
  registry.register(getStockPriceTool);
  registry.register(calculatorTool);

  // 构建 pipeline（空中间件）
  const pipeline = new MiddlewarePipeline([]);
  const executor = new ToolExecutor(registry, pipeline);

  // 构建最小化 context
  const ctx: AgentRunContext = {
    input: { inputText: "batch demo" },
    identity: { userId: "demo", tenantId: "default", roles: [] },
    state: {
      runId: generateId("run"),
      messages: [],
      scratchpad: {},
      memory: {},
      stepCount: 0,
      status: "running",
    },
    services: {},
    metadata: {},
  };

  // --- 验证 translate 工具的 validateInput ---
  console.log("  --- validateInput 测试 ---");
  const validResult = translateTool.validateInput!(
    { text: "hello", targetLang: "zh" },
    {
      runContext: ctx,
      toolCall: { id: "test", name: "translate", input: {} },
      backend: undefined,
    },
  );
  console.log(`  合法输入: ${JSON.stringify(validResult)}`);

  const invalidResult = translateTool.validateInput!(
    { text: "", targetLang: "xx" },
    {
      runContext: ctx,
      toolCall: { id: "test", name: "translate", input: {} },
      backend: undefined,
    },
  );
  console.log(`  非法输入: ${JSON.stringify(invalidResult)}`);

  // --- 测试 isConcurrencySafe / isReadOnly ---
  console.log("\n  --- 工具属性 ---");
  console.log(`  translate.isConcurrencySafe: ${translateTool.isConcurrencySafe!({})}`);
  console.log(`  translate.isReadOnly:         ${translateTool.isReadOnly!({})}`);
  console.log(
    `  get_stock_price.isConcurrencySafe: ${getStockPriceTool.isConcurrencySafe?.({}) ?? false}`,
  );

  // --- 构建 batch calls ---
  // 两个 translate（concurrency-safe）+ 一个 get_stock_price（non-safe）
  // translate 调用会被分组并行执行，get_stock_price 串行执行
  const calls: Array<Extract<AgentStreamEvent, { type: "tool_call" }>["call"]> = [
    { id: "call_1", name: "translate", input: { text: "hello", targetLang: "zh" } },
    { id: "call_2", name: "translate", input: { text: "world", targetLang: "zh" } },
    { id: "call_3", name: "get_stock_price", input: { symbol: "AAPL" } },
    { id: "call_4", name: "calculator", input: { expression: "2 + 3 * 4" } },
  ];

  console.log("\n  --- runBatch 执行 ---");
  console.log(`  提交 ${calls.length} 个工具调用...\n`);

  const batchResults = await executor.runBatch(calls, ctx);

  for (const { call, result } of batchResults) {
    console.log(`  [${call.id}] ${call.name}(${JSON.stringify(call.input)})`);
    console.log(`       → ${result.output.content}`);
  }

  console.log(`\n  batch 完成，共 ${batchResults.length} 个结果\n`);
}

// ============================================================
// Demo 4: 直接使用 AgentRuntime（手动构建 context + runtime）
// ============================================================

async function demo4(client: ReturnType<typeof createModelClient>) {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Demo 4: 直接使用 AgentRuntime — 底层控制                  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // 手动构建 AgentRunContext
  const runId = generateId("run");
  const identity: AgentIdentity = {
    userId: "demo-user",
    tenantId: "tenant-001",
    roles: ["admin"],
    sessionId: "session-001",
  };

  const state: AgentState = {
    runId,
    messages: [],
    scratchpad: {},
    memory: {},
    stepCount: 0,
    status: "running",
  };

  const services: AgentServices = {
    audit: new ConsoleAuditLogger(),
    checkpoint: new InMemoryCheckpointStore(),
  };

  const ctx: AgentRunContext = {
    input: { inputText: "北京天气怎么样？顺便算一下 (10 + 5) * 3" },
    identity,
    state,
    services,
    metadata: { source: "direct-runtime-demo" },
  };

  // 手动构建 AgentRuntime
  const runtime = new AgentRuntime({
    name: "direct-runtime",
    modelClient: client,
    model: "openrouter:qwen/qwen3.6-plus-preview:free",
    tools: [getWeatherTool, calculatorTool],
    systemPrompt: "你是一个助手。使用 get_weather 查天气，使用 calculator 做计算。用中文回答。",
    maxSteps: 5,
    ...(services.audit ? { audit: services.audit } : {}),
    ...(services.checkpoint ? { checkpoint: services.checkpoint } : {}),
  });

  const result = await runtime.run(ctx);

  console.log(`  runId:  ${result.runId}`);
  console.log(`  状态:   ${result.status}`);
  console.log(`  步数:   ${result.state.stepCount}`);
  if (result.output) console.log(`  回复:   ${result.output.slice(0, 300)}`);
  if (result.error) console.log(`  错误:   ${result.error.code} — ${result.error.message}`);
  console.log(`  消息数: ${result.state.messages.length}`);
  console.log();
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

  // ---- Demo 1: 基础天气助手 ----
  await demo1(modelClient);

  // ---- Demo 2: 流式金融助手 ----
  await demo2(modelClient);

  // ---- Demo 3: 多工具并发 + 输入验证（不需要 API key）----
  await demo3();

  // ---- Demo 4: 直接使用 AgentRuntime ----
  await demo4(modelClient);

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  所有 Demo 完成");
  console.log("══════════════════════════════════════════════════════════════");
}

main().catch((error: unknown) => {
  console.error("Demo error:", error);
  process.exit(1);
});
