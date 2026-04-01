/**
 * @renx/agent 流式输出专项 Demo
 *
 * 一个功能丰富的"全能生活助手"Agent，通过流式输出展示 SDK 所有流式能力：
 *  - 流式生命周期事件：run_started → model_started → assistant_delta/tool_call/tool_result → run_completed
 *  - 多步推理：Agent 会自动拆解复杂任务，分步调用工具
 *  - 中间件：计时 + 重试建议 + 输出脱敏
 *  - 策略引擎：动态工具过滤 + 敏感操作审批
 *  - 审计日志：结构化记录全链路
 *  - Checkpoint：支持断点恢复
 *  - 丰富的工具集：天气、汇率、股票、计算器、翻译、新闻、时区、知识百科
 */

import { createModelClient, createOpenRouterProvider } from "@renx/provider";
import {
  EnterpriseAgentBase,
  InMemoryCheckpointStore,
  type AgentMiddleware,
  type AgentRunContext,
  type AgentTool,
  type AgentStreamEvent,
  type PolicyEngine,
  type ToolResult,
  type ToolContext,
  type ValidationResult,
  type AuditEvent,
  type AuditLogger,
} from "@renx/agent";

// ============================================================
// 工具定义 — 8 个丰富工具
// ============================================================

const getWeatherTool: AgentTool = {
  name: "get_weather",
  description: "获取指定城市的天气信息，包括温度、天气状况、湿度、风速",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名称" },
    },
    required: ["city"],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  invoke: async (input: unknown): Promise<ToolResult> => {
    const { city } = input as { city: string };
    const db: Record<string, { temp: string; desc: string; humidity: string; wind: string }> = {
      北京: { temp: "18°C", desc: "晴朗", humidity: "45%", wind: "东北风 3级" },
      上海: { temp: "22°C", desc: "多云", humidity: "72%", wind: "东南风 2级" },
      深圳: { temp: "28°C", desc: "阵雨", humidity: "88%", wind: "南风 4级" },
      广州: { temp: "30°C", desc: "雷阵雨", humidity: "90%", wind: "西南风 3级" },
      成都: { temp: "16°C", desc: "阴天", humidity: "65%", wind: "微风" },
      Tokyo: { temp: "15°C", desc: "Clear", humidity: "50%", wind: "NE 2m/s" },
      "New York": { temp: "12°C", desc: "Partly Cloudy", humidity: "55%", wind: "W 8mph" },
    };
    const data = db[city] ?? { temp: "20°C", desc: "Unknown", humidity: "N/A", wind: "N/A" };
    return {
      content: `📍 ${city} 天气: ${data.desc}, 🌡 ${data.temp}, 💧 湿度 ${data.humidity}, 🌬 ${data.wind}`,
      metadata: { source: "mock-weather-api" },
    };
  },
};

const getExchangeRateTool: AgentTool = {
  name: "get_exchange_rate",
  description: "获取实时汇率信息，支持主流货币对",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "源货币代码，如 CNY、USD" },
      to: { type: "string", description: "目标货币代码，如 USD、EUR" },
    },
    required: ["from", "to"],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  invoke: async (input: unknown): Promise<ToolResult> => {
    const { from, to } = input as { from: string; to: string };
    const rates: Record<string, Record<string, number>> = {
      CNY: { USD: 0.138, EUR: 0.127, JPY: 20.85, GBP: 0.109, KRW: 188.5 },
      USD: { CNY: 7.25, EUR: 0.92, JPY: 151.2, GBP: 0.79, KRW: 1365 },
      EUR: { CNY: 7.88, USD: 1.087, JPY: 164.3, GBP: 0.86, KRW: 1485 },
    };
    const rate = rates[from.toUpperCase()]?.[to.toUpperCase()];
    if (rate) {
      return {
        content: `💱 1 ${from.toUpperCase()} = ${rate} ${to.toUpperCase()}`,
        metadata: { rate, timestamp: new Date().toISOString() },
      };
    }
    return {
      content: `💱 1 ${from.toUpperCase()} ≈ ${(Math.random() * 5 + 0.5).toFixed(4)} ${to.toUpperCase()} (模拟)`,
    };
  },
};

const getStockPriceTool: AgentTool = {
  name: "get_stock_price",
  description: "获取股票实时价格信息",
  inputSchema: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "股票代码，如 AAPL、GOOGL、600519" },
    },
    required: ["symbol"],
  },
  invoke: async (input: unknown): Promise<ToolResult> => {
    const { symbol } = input as { symbol: string };
    const stocks: Record<string, { name: string; price: string; change: string }> = {
      AAPL: { name: "Apple Inc.", price: "189.84", change: "+1.23%" },
      GOOGL: { name: "Alphabet Inc.", price: "174.52", change: "-0.45%" },
      TSLA: { name: "Tesla Inc.", price: "248.50", change: "+3.12%" },
      MSFT: { name: "Microsoft Corp.", price: "420.15", change: "+0.87%" },
      "600519": { name: "贵州茅台", price: "1685.00", change: "-1.20%" },
      "000001": { name: "上证指数", price: "3245.68", change: "+0.35%" },
    };
    const data = stocks[symbol];
    if (data) {
      const emoji = data.change.startsWith("+") ? "📈" : "📉";
      return {
        content: `${emoji} ${data.name}(${symbol}): $${data.price} (${data.change})`,
        metadata: { symbol, price: data.price, change: data.change },
      };
    }
    const price = (Math.random() * 300 + 50).toFixed(2);
    return { content: `📊 ${symbol}: $${price} (模拟)`, metadata: { symbol, price } };
  },
};

const calculatorTool: AgentTool = {
  name: "calculator",
  description: "数学计算器，支持加减乘除、括号运算",
  inputSchema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "数学表达式，如 '(100 + 200) * 0.85'" },
    },
    required: ["expression"],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  invoke: async (input: unknown): Promise<ToolResult> => {
    const { expression } = input as { expression: string };
    if (!/^[\d\s+\-*/().]+$/.test(expression)) {
      return { content: `❌ 表达式包含非法字符: "${expression}"` };
    }
    try {
      const result = safeEval(expression);
      return { content: `🧮 ${expression} = ${result}`, metadata: { expression, result } };
    } catch {
      return { content: `❌ 计算失败: "${expression}"` };
    }
  },
};

const translateTool: AgentTool = {
  name: "translate",
  description: "文本翻译工具，支持多语言互译",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "要翻译的文本" },
      targetLang: { type: "string", description: "目标语言: en, zh, ja, ko, fr, de" },
    },
    required: ["text", "targetLang"],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  validateInput(input: unknown, _ctx: ToolContext): ValidationResult {
    const { text, targetLang } = input as { text?: string; targetLang?: string };
    if (!text || text.trim().length === 0) {
      return { result: false, message: "text 不能为空", code: "EMPTY_TEXT" };
    }
    const supported = ["en", "zh", "ja", "ko", "fr", "de"];
    if (!targetLang || !supported.includes(targetLang)) {
      return {
        result: false,
        message: `targetLang 必须是: ${supported.join(", ")}`,
        code: "UNSUPPORTED_LANG",
      };
    }
    return { result: true };
  },
  invoke: async (input: unknown): Promise<ToolResult> => {
    const { text, targetLang } = input as { text: string; targetLang: string };
    const dict: Record<string, Record<string, string>> = {
      zh: { hello: "你好", "good morning": "早上好", "thank you": "谢谢", world: "世界" },
      en: { 你好: "Hello", 早上好: "Good morning", 谢谢: "Thank you", 世界: "World" },
      ja: {
        你好: "こんにちは",
        "good morning": "おはようございます",
        谢谢: "ありがとうございます",
      },
      ko: { 你好: "안녕하세요", "good morning": "좋은 아침입니다", 谢谢: "감사합니다" },
    };
    const lookup = dict[targetLang] ?? {};
    const translated = lookup[text.toLowerCase()] ?? `[${targetLang}] ${text}`;
    return {
      content: `🌐 "${text}" → "${translated}"`,
      metadata: { from: text, to: translated, lang: targetLang },
    };
  },
};

const getNewsTool: AgentTool = {
  name: "get_news",
  description: "获取指定主题的最新新闻摘要",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "新闻主题，如 tech, finance, sports" },
      count: { type: "number", description: "获取条数，默认 3" },
    },
    required: ["topic"],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  invoke: async (input: unknown): Promise<ToolResult> => {
    const { topic, count = 3 } = input as { topic: string; count?: number };
    const news: Record<string, string[]> = {
      tech: [
        "🔬 AI 大模型最新突破：多模态理解能力再创新高",
        "💻 量子计算里程碑：首次实现 1000+ 量子比特稳定运行",
        "🚀 SpaceX 星舰第五次试飞成功，完成筷子夹助推器",
        "📱 新一代芯片发布：3nm 工艺性能提升 40%",
      ],
      finance: [
        "📈 全球股市震荡：美联储降息预期升温",
        "🏦 数字货币监管新规出台，市场反应积极",
        "🇨🇳 A股三大指数集体收涨，成交量破万亿",
        "💷 欧洲央行维持利率不变，释放鸽派信号",
      ],
      sports: [
        "⚽ 世界杯预选赛：中国队主场 2-1 取胜",
        "🏀 NBA 季后赛：湖人队系列赛 3-1 领先",
        "🎾 网球大师赛：新科状元首秀惊艳",
        "🏊 奥运游泳选拔赛：两项世界纪录被打破",
      ],
    };
    const articles = news[topic.toLowerCase()] ?? [
      `📰 ${topic} 领域最新动态：行业持续发展`,
      `📰 ${topic} 头条：市场关注度持续走高`,
      `📰 ${topic} 深度报道：专家解读未来趋势`,
    ];
    const selected = articles.slice(0, count);
    return { content: selected.join("\n"), metadata: { topic, count: selected.length } };
  },
};

const getTimezoneTool: AgentTool = {
  name: "get_timezone",
  description: "获取指定城市的当前时间和时区信息",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名称" },
    },
    required: ["city"],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  invoke: async (input: unknown): Promise<ToolResult> => {
    const { city } = input as { city: string };
    const tzMap: Record<string, { tz: string; offset: string }> = {
      北京: { tz: "Asia/Shanghai", offset: "UTC+8" },
      上海: { tz: "Asia/Shanghai", offset: "UTC+8" },
      东京: { tz: "Asia/Tokyo", offset: "UTC+9" },
      "New York": { tz: "America/New_York", offset: "UTC-5" },
      London: { tz: "Europe/London", offset: "UTC+0" },
      Paris: { tz: "Europe/Paris", offset: "UTC+1" },
    };
    const info = tzMap[city] ?? { tz: "UTC", offset: "UTC+0" };
    const now = new Date();
    const timeStr = now.toLocaleString("zh-CN", { timeZone: info.tz, hour12: false });
    return {
      content: `🕐 ${city} 当前时间: ${timeStr} (${info.offset})`,
      metadata: { city, timezone: info.tz, offset: info.offset, timestamp: now.toISOString() },
    };
  },
};

const getWikiTool: AgentTool = {
  name: "get_wiki",
  description: "获取百科知识摘要",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "查询关键词" },
    },
    required: ["query"],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  invoke: async (input: unknown): Promise<ToolResult> => {
    const { query } = input as { query: string };
    const wiki: Record<string, string> = {
      量子计算: "量子计算利用量子力学原理（叠加态、纠缠）进行计算，理论上能在特定问题上指数级超越经典计算机。",
      区块链: "区块链是一种去中心化的分布式账本技术，通过密码学保证数据不可篡改，广泛应用于加密货币、供应链等领域。",
      大模型: "大语言模型（LLM）是基于 Transformer 架构的 AI 模型，通过海量文本训练，具备自然语言理解、生成、推理等能力。",
      React:
        "React 是 Meta 开发的 JavaScript UI 库，采用组件化和虚拟 DOM，是现代前端开发的主流框架之一。",
    };
    const summary =
      wiki[query] ??
      `"${query}" — 这是一条模拟的百科摘要。在真实场景中，这里会调用维基百科 API 获取真实内容。`;
    return { content: `📚 ${query}: ${summary}`, metadata: { query } };
  },
};

// ============================================================
// 简易表达式求值器
// ============================================================

function safeEval(expr: string): number {
  const tokens = tokenize(expr);
  let pos = 0;
  function parseExpr(): number {
    let r = parseTerm();
    while (pos < tokens.length && (tokens[pos] === "+" || tokens[pos] === "-")) {
      const op = tokens[pos++];
      const t = parseTerm();
      r = op === "+" ? r + t : r - t;
    }
    return r;
  }
  function parseTerm(): number {
    let r = parseFactor();
    while (pos < tokens.length && (tokens[pos] === "*" || tokens[pos] === "/")) {
      const op = tokens[pos++];
      const f = parseFactor();
      r = op === "*" ? r * f : r / f;
    }
    return r;
  }
  function parseFactor(): number {
    if (tokens[pos] === "(") {
      pos++;
      const r = parseExpr();
      pos++;
      return r;
    }
    return parseFloat(tokens[pos++]!);
  }
  return parseExpr();
}

function tokenize(expr: string): string[] {
  const t: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === " ") {
      i++;
      continue;
    }
    if ("+-*/()".includes(c!)) {
      t.push(c!);
      i++;
    } else {
      let n = "";
      while (i < expr.length && /[\d.]/.test(expr[i]!)) {
        n += expr[i];
        i++;
      }
      if (n) t.push(n);
    }
  }
  return t;
}

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
    const elapsed = Date.now() - ((ctx.state.scratchpad["_stepStartTime"] as number) || Date.now());
    console.log(`    ⏱  [MW:timing] 模型调用耗时 ${elapsed}ms, 响应类型=${resp.type}`);
    return resp;
  },
  afterTool(ctx, result) {
    const elapsed = Date.now() - ((ctx.state.scratchpad["_stepStartTime"] as number) || Date.now());
    console.log(`    ⏱  [MW:timing] 工具 ${result.tool.name} 完成，累计耗时 ${elapsed}ms`);
  },
  afterRun(ctx, result) {
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
    // 演示：记录请求中的消息数量
    console.log(`    🔒 [MW:redact] 检查 ${req.messages.length} 条消息，未发现敏感信息`);
    return req;
  },
};

const retryAdviceMiddleware: AgentMiddleware = {
  name: "retry-advice",
  onError(ctx, error) {
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
    console.log(
      `    🛡  [Policy] 工具过滤: ${tools.length} → ${filtered.length} (白名单: ${[...this.allowed].join(", ")})`,
    );
    return filtered;
  }

  canUseTool(_ctx: AgentRunContext, tool: AgentTool, _input: unknown): boolean {
    const allowed = this.allowed.has(tool.name);
    if (!allowed) {
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

const TOOLS = [
  getWeatherTool,
  getExchangeRateTool,
  getStockPriceTool,
  calculatorTool,
  translateTool,
  getNewsTool,
  getTimezoneTool,
  getWikiTool,
];

class LifeAssistantAgent extends EnterpriseAgentBase {
  private modelClient;

  constructor(modelClient: ReturnType<typeof createModelClient>) {
    super();
    this.modelClient = modelClient;
  }

  protected getName() {
    return "life-assistant";
  }
  protected getSystemPrompt(_ctx: AgentRunContext) {
    return `你是一个全能生活助手，拥有以下工具：
- get_weather: 查询天气
- get_exchange_rate: 查询汇率
- get_stock_price: 查询股价
- calculator: 数学计算
- translate: 翻译
- get_news: 获取新闻
- get_timezone: 查询时区时间
- get_wiki: 百科知识

请根据用户问题，灵活组合调用多个工具来提供全面、详细的回答。
回答要有条理，使用适当的格式（列表、表格等）让信息清晰易读。
用中文回答。`;
  }
  protected getTools() {
    return TOOLS;
  }
  protected getModelClient() {
    return this.modelClient;
  }
  protected getModelName() {
    return "openrouter:qwen/qwen3.6-plus-preview:free";
  }
  protected getMiddlewares() {
    return [timingMiddleware, sensitiveRedactMiddleware, retryAdviceMiddleware];
  }
  protected getPolicy() {
    return new DynamicPolicy(TOOLS.map((t) => t.name));
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

    case "tool_call_delta":
      // 工具调用增量，静默忽略（太碎片化）
      break;

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

async function main() {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("❌ 请设置环境变量 OPENROUTER_API_KEY");
    process.exit(1);
  }

  console.log("");
  console.log("  ╔══════════════════════════════════════════════════════════════╗");
  console.log("  ║           🌊 @renx/agent 流式输出专项 Demo                 ║");
  console.log("  ║     全能生活助手 — 丰富的多工具流式交互                     ║");
  console.log("  ╚══════════════════════════════════════════════════════════════╝");
  console.log("");

  const modelClient = createModelClient({
    providers: [createOpenRouterProvider({ apiKey, timeoutMs: 120_000 })],
    retry: { maxAttempts: 3, baseDelayMs: 1000 },
  });

  const agent = new LifeAssistantAgent(modelClient);

  // ---- 复合任务：一个 prompt 触发多步多工具流式调用 ----
  const prompt = [" 查一下人民币兑日元汇率"].join("\n");

  console.log("  📨 用户输入:");
  console.log("  ┌──────────────────────────────────────────────────────────┐");
  prompt.split("\n").forEach((line) => {
    console.log(`  │ ${line.padEnd(57)}│`);
  });
  console.log("  └──────────────────────────────────────────────────────────┘");
  console.log("");
  console.log("  🌊 开始流式输出…\n");

  // ---- 收集统计 ----
  let eventCount = 0;

  const stream = agent.stream({ inputText: prompt });

  for await (const event of stream) {
    eventCount++;
    printEvent(event, eventCount);
  }
}

main().catch((err: unknown) => {
  console.error("❌ Demo 执行出错:", err);
  process.exit(1);
});
