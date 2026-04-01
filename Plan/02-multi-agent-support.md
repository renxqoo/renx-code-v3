# 02 - 多 Agent 协作 (Multi-Agent Support)

## 问题陈述

当前 SDK 只支持单 Agent 运行，无法实现以下场景：

1. **任务委派** — 主 Agent 将子任务委派给专门的子 Agent（如代码生成 Agent、测试 Agent、审查 Agent）
2. **并行协作** — 多个 Agent 同时处理独立子任务，结果汇总
3. **流水线编排** — Agent 之间形成处理流水线（A 的输出作为 B 的输入）
4. **对话转交** — 根据用户意图动态切换到不同领域的 Agent

### 对标分析

| 能力 | Claude Code | renx-code-v3 当前 |
|------|------------|-------------------|
| 子 Agent 派生 | 有（subagent/tool） | 无 |
| Agent 间通信 | 有（通过 context） | 无 |
| 协调器模式 | 有（coordinator） | 无 |
| 嵌套调用 | 有（无限深度） | 无 |
| Agent 结果汇总 | 有 | 无 |

## 架构设计

### 核心概念

```
┌─────────────────────────────────────────────────────┐
│               AgentOrchestrator                      │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ AgentRegistry│  │ Orchestratio-│  │ SubAgentTo-│ │
│  │             │  │ nStrategy    │  │ ol         │ │
│  │ - register  │  │              │  │            │ │
│  │ - resolve   │  │ - sequential │  │ - spawn    │ │
│  │ - list      │  │ - parallel   │  │ - collect  │ │
│  │             │  │ - pipeline   │  │ - delegate │ │
│  └─────────────┘  └──────────────┘  └────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 新增文件清单

```
src/multi-agent/
  index.ts                    — barrel export
  agent-registry.ts           — Agent 注册表
  sub-agent-tool.ts           — 子 Agent 作为工具
  orchestrator.ts             — 编排器
  strategies/
    sequential-strategy.ts    — 顺序执行策略
    parallel-strategy.ts      — 并行执行策略
    pipeline-strategy.ts      — 流水线执行策略
    router-strategy.ts        — 路由分发策略
  types.ts                    — 多 Agent 类型定义
```

---

## 详细设计

### 1. 类型定义

```typescript
// src/multi-agent/types.ts

import type { AgentResult, AgentRunContext, AgentStreamEvent, AgentTool } from "../types";
import type { ModelClient } from "@renx/model";

/**
 * Agent 定义，描述一个可被编排的 Agent。
 */
export interface AgentDefinition {
  /** Agent 唯一标识 */
  name: string;
  /** Agent 描述（用于路由决策和调试） */
  description: string;
  /** 系统提示 */
  systemPrompt: string;
  /** 工具列表 */
  tools: AgentTool[];
  /** 模型名称 */
  model: string;
  /** 最大步数 */
  maxSteps?: number;
  /** 是否允许该 Agent 再派生子 Agent */
  allowSpawn?: boolean;
  /** 最大递归深度（防止无限嵌套） */
  maxDepth?: number;
}

/**
 * 子 Agent 执行请求。
 */
export interface SubAgentRequest {
  /** 目标 Agent 名称 */
  agentName: string;
  /** 输入文本 */
  input: string;
  /** 额外上下文（父 Agent 传递给子 Agent 的信息） */
  context?: Record<string, unknown>;
  /** 是否等待子 Agent 完成（vs 异步触发后立即返回） */
  waitForCompletion?: boolean;
  /** 超时时间（ms） */
  timeoutMs?: number;
}

/**
 * 子 Agent 执行结果。
 */
export interface SubAgentResult {
  /** 执行的 Agent 名称 */
  agentName: string;
  /** 执行状态 */
  status: "completed" | "failed" | "timeout";
  /** Agent 输出 */
  output?: string;
  /** 错误信息 */
  error?: string;
  /** 执行耗时（ms） */
  durationMs: number;
  /** 子 Agent 的状态摘要 */
  stateSummary?: {
    steps: number;
    toolCallsCount: number;
  };
}

/**
 * 编排策略接口。
 */
export interface OrchestrationStrategy {
  /** 策略名称 */
  readonly name: string;

  /**
   * 执行编排。
   * @param agents 按顺序排列的 Agent 定义
   * @param input 初始输入
   * @param context 运行上下文
   * @param executor 执行器（用于实际运行 Agent）
   */
  execute(
    agents: AgentDefinition[],
    input: string,
    context: AgentRunContext,
    executor: AgentExecutor,
  ): Promise<OrchestrationResult>;
}

/**
 * Agent 执行器接口（由 Runtime 实现）。
 */
export interface AgentExecutor {
  /**
   * 执行单个 Agent。
   */
  runAgent(
    definition: AgentDefinition,
    input: string,
    parentContext: AgentRunContext,
  ): Promise<AgentResult>;

  /**
   * 流式执行单个 Agent。
   */
  streamAgent(
    definition: AgentDefinition,
    input: string,
    parentContext: AgentRunContext,
  ): AsyncGenerator<AgentStreamEvent, AgentResult>;
}

/**
 * 编排结果。
 */
export interface OrchestrationResult {
  /** 各 Agent 的执行结果 */
  results: SubAgentResult[];
  /** 最终汇总输出 */
  finalOutput: string;
  /** 总执行耗时 */
  totalDurationMs: number;
  /** 执行策略名称 */
  strategy: string;
}
```

### 2. AgentRegistry — Agent 注册表

```typescript
// src/multi-agent/agent-registry.ts

/**
 * Agent 注册表，管理可用的 Agent 定义。
 *
 * 支持：
 * - 注册/注销 Agent
 * - 按名称查找
 * - 列出所有 Agent（含描述，用于路由）
 * - 嵌套注册表（子命名空间）
 */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  /**
   * 注册一个 Agent。
   * @throws 如果名称已存在
   */
  register(definition: AgentDefinition): void {
    if (this.agents.has(definition.name)) {
      throw new Error(`Agent already registered: ${definition.name}`);
    }
    this.agents.set(definition.name, definition);
  }

  /**
   * 注销一个 Agent。
   */
  unregister(name: string): boolean {
    return this.agents.delete(name);
  }

  /**
   * 按名称查找 Agent。
   */
  resolve(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  /**
   * 列出所有已注册的 Agent。
   */
  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  /**
   * 列出所有 Agent 的名称和描述（用于路由和展示）。
   */
  listDescriptions(): Array<{ name: string; description: string }> {
    return this.list().map((a) => ({ name: a.name, description: a.description }));
  }

  /**
   * 检查是否存在指定名称的 Agent。
   */
  has(name: string): boolean {
    return this.agents.has(name);
  }
}
```

### 3. SubAgentTool — 子 Agent 作为工具

这是最核心的设计：将子 Agent 封装为工具，主 Agent 可以像调用普通工具一样调用子 Agent。

```typescript
// src/multi-agent/sub-agent-tool.ts

/**
 * 将子 Agent 封装为工具，使主 Agent 能通过工具调用的方式委派任务给子 Agent。
 *
 * 这是多 Agent 架构的基础原语：
 * - 主 Agent 的工具列表中包含 SubAgentTool
 * - 当主 Agent 决定委派任务时，调用该工具
 * - 工具内部创建一个新的 AgentRuntime 执行子 Agent
 * - 子 Agent 的结果作为工具结果返回给主 Agent
 */
export class SubAgentTool implements AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;

  private readonly registry: AgentRegistry;
  private readonly modelClient: ModelClient;
  private readonly parentMaxDepth: number;
  private readonly currentDepth: number;

  constructor(options: {
    registry: AgentRegistry;
    modelClient: ModelClient;
    /** 工具名称（默认 "delegate_to_agent"） */
    toolName?: string;
    /** 当前递归深度 */
    currentDepth?: number;
    /** 最大递归深度（默认 3） */
    maxDepth?: number;
  }) {
    this.registry = options.registry;
    this.modelClient = options.modelClient;
    this.currentDepth = options.currentDepth ?? 0;
    this.parentMaxDepth = options.maxDepth ?? 3;

    this.name = options.toolName ?? "delegate_to_agent";
    this.description = `将任务委派给专门的子 Agent 处理。可选的 Agent：${this.registry.listDescriptions()
      .map((a) => `${a.name}（${a.description}）`)
      .join("、")}`;
    this.inputSchema = {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "目标 Agent 名称",
          enum: this.registry.list().map((a) => a.name),
        },
        task: {
          type: "string",
          description: "要委派的任务描述",
        },
        context: {
          type: "object",
          description: "传递给子 Agent 的额外上下文信息",
        },
      },
      required: ["agent_name", "task"],
    };
  }

  async invoke(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { agent_name, task, context } = input as {
      agent_name: string;
      task: string;
      context?: Record<string, unknown>;
    };

    // 深度检查
    if (this.currentDepth >= this.parentMaxDepth) {
      return {
        content: `❌ 已达到最大递归深度 (${this.parentMaxDepth})，无法继续派生子 Agent`,
      };
    }

    // 解析目标 Agent
    const agentDef = this.registry.resolve(agent_name);
    if (!agentDef) {
      return {
        content: `❌ 未找到 Agent: ${agent_name}。可用的 Agent: ${this.registry.list().map((a) => a.name).join(", ")}`,
      };
    }

    const startTime = Date.now();

    try {
      // 构建子 Agent 的输入
      let agentInput = task;
      if (context) {
        agentInput = `上下文信息: ${JSON.stringify(context)}\n\n任务: ${task}`;
      }

      // 创建子 Agent Runtime 并执行
      const subRuntime = new AgentRuntime({
        name: agentDef.name,
        modelClient: this.modelClient,
        model: agentDef.model,
        tools: agentDef.allowSpawn !== false
          ? [
            ...agentDef.tools,
            // 递归注入 SubAgentTool（深度 +1）
            new SubAgentTool({
              registry: this.registry,
              modelClient: this.modelClient,
              currentDepth: this.currentDepth + 1,
              maxDepth: this.parentMaxDepth,
            }) as unknown as AgentTool,
          ]
          : agentDef.tools,
        systemPrompt: agentDef.systemPrompt,
        maxSteps: agentDef.maxSteps ?? 5,
      });

      const subCtx = this.createSubContext(ctx.runContext, agentInput);
      const result = await subRuntime.run(subCtx);

      const durationMs = Date.now() - startTime;

      if (result.status === "completed") {
        return {
          content: `✅ 子 Agent "${agentDef.name}" 完成任务（耗时 ${durationMs}ms，${result.state.stepCount} 步）:\n${result.output ?? "（无输出）"}`,
          metadata: {
            agentName: agentDef.name,
            durationMs,
            steps: result.state.stepCount,
            toolCallsCount: result.state.messages.filter(
              (m) => m.role === "tool",
            ).length,
          },
        };
      }

      return {
        content: `⚠️ 子 Agent "${agentDef.name}" 未成功完成（状态: ${result.status}）: ${result.error?.message ?? "未知错误"}`,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      return {
        content: `❌ 子 Agent "${agentDef.name}" 执行失败（耗时 ${durationMs}ms）: ${error instanceof Error ? error.message : "未知错误"}`,
      };
    }
  }

  /**
   * 创建子 Agent 的运行上下文。
   * 继承父 Agent 的 identity 和 services，创建新的 state。
   */
  private createSubContext(
    parentCtx: AgentRunContext,
    input: string,
  ): AgentRunContext {
    return {
      input: { inputText: input },
      identity: parentCtx.identity,
      state: {
        runId: generateId(),
        messages: [],
        scratchpad: {},
        memory: { ...parentCtx.state.memory },
        stepCount: 0,
        status: "running",
      },
      services: parentCtx.services,
      metadata: {
        parentRunId: parentCtx.state.runId,
        spawnedAt: new Date().toISOString(),
      },
    };
  }
}
```

### 4. Orchestrator — 编排器

```typescript
// src/multi-agent/orchestrator.ts

/**
 * 多 Agent 编排器。
 *
 * 提供多种编排策略，支持：
 * - sequential: Agent 按顺序执行，前一个的输出作为后一个的输入
 * - parallel: Agent 并行执行，结果汇总
 * - pipeline: Agent 形成处理流水线
 * - router: 根据输入动态选择 Agent
 */
export class AgentOrchestrator {
  private readonly registry: AgentRegistry;
  private readonly modelClient: ModelClient;

  constructor(options: {
    registry: AgentRegistry;
    modelClient: ModelClient;
  }) {
    this.registry = options.registry;
    this.modelClient = options.modelClient;
  }

  /**
   * 使用指定策略执行编排。
   */
  async orchestrate(
    strategy: OrchestrationStrategy,
    agentNames: string[],
    input: string,
    context: AgentRunContext,
  ): Promise<OrchestrationResult> {
    const agents = agentNames
      .map((name) => this.registry.resolve(name))
      .filter((a): a is AgentDefinition => a !== undefined);

    if (agents.length === 0) {
      throw new Error(`No agents found for names: ${agentNames.join(", ")}`);
    }

    const executor = this.createExecutor();
    const startTime = Date.now();

    const result = await strategy.execute(agents, input, context, executor);

    return {
      ...result,
      totalDurationMs: Date.now() - startTime,
      strategy: strategy.name,
    };
  }

  /**
   * 快捷方法：顺序执行。
   */
  async sequential(
    agentNames: string[],
    input: string,
    context: AgentRunContext,
  ): Promise<OrchestrationResult> {
    return this.orchestrate(
      new SequentialStrategy(),
      agentNames,
      input,
      context,
    );
  }

  /**
   * 快捷方法：并行执行。
   */
  async parallel(
    agentNames: string[],
    input: string,
    context: AgentRunContext,
  ): Promise<OrchestrationResult> {
    return this.orchestrate(
      new ParallelStrategy(),
      agentNames,
      input,
      context,
    );
  }

  /**
   * 快捷方法：路由分发。
   */
  async route(
    input: string,
    context: AgentRunContext,
  ): Promise<OrchestrationResult> {
    return this.orchestrate(
      new RouterStrategy(this.modelClient),
      this.registry.list().map((a) => a.name),
      input,
      context,
    );
  }

  private createExecutor(): AgentExecutor {
    return {
      runAgent: async (definition, input, parentContext) => {
        const runtime = new AgentRuntime({
          name: definition.name,
          modelClient: this.modelClient,
          model: definition.model,
          tools: definition.tools,
          systemPrompt: definition.systemPrompt,
          maxSteps: definition.maxSteps ?? 5,
        });

        const ctx: AgentRunContext = {
          input: { inputText: input },
          identity: parentContext.identity,
          state: {
            runId: generateId(),
            messages: [],
            scratchpad: {},
            memory: { ...parentContext.state.memory },
            stepCount: 0,
            status: "running",
          },
          services: parentContext.services,
          metadata: {},
        };

        return runtime.run(ctx);
      },
      async *streamAgent(definition, input, parentContext) {
        // 与 runAgent 相同的上下文构建
        const runtime = new AgentRuntime({
          name: definition.name,
          modelClient: this.modelClient,
          model: definition.model,
          tools: definition.tools,
          systemPrompt: definition.systemPrompt,
          maxSteps: definition.maxSteps ?? 5,
        });

        const ctx: AgentRunContext = {
          input: { inputText: input },
          identity: parentContext.identity,
          state: {
            runId: generateId(),
            messages: [],
            scratchpad: {},
            memory: { ...parentContext.state.memory },
            stepCount: 0,
            status: "running",
          },
          services: parentContext.services,
          metadata: {},
        };

        yield* runtime.stream(ctx);
      },
    };
  }
}
```

### 5. 编排策略实现

#### 5a. SequentialStrategy

```typescript
// src/multi-agent/strategies/sequential-strategy.ts

/**
 * 顺序执行策略。
 * Agent 按顺序执行，前一个的输出作为后一个的输入（chain）。
 *
 * 适用场景：流水线处理，如 "分析 → 生成 → 审查"
 */
export class SequentialStrategy implements OrchestrationStrategy {
  readonly name = "sequential";

  async execute(
    agents: AgentDefinition[],
    input: string,
    context: AgentRunContext,
    executor: AgentExecutor,
  ): Promise<OrchestrationResult> {
    const results: SubAgentResult[] = [];
    let currentInput = input;

    for (const agent of agents) {
      const startTime = Date.now();
      const result = await executor.runAgent(agent, currentInput, context);
      const durationMs = Date.now() - startTime;

      const subResult: SubAgentResult = {
        agentName: agent.name,
        status: result.status === "completed" ? "completed" : "failed",
        output: result.output,
        error: result.error?.message,
        durationMs,
        stateSummary: {
          steps: result.state.stepCount,
          toolCallsCount: result.state.messages.filter(
            (m) => m.role === "tool",
          ).length,
        },
      };

      results.push(subResult);

      // 如果某个 Agent 失败，是否继续？
      if (result.status !== "completed") {
        break;
      }

      // 将输出传递给下一个 Agent
      currentInput = result.output ?? "";
    }

    // 最终输出是最后一个 Agent 的输出
    const lastResult = results[results.length - 1];
    const finalOutput = lastResult?.output ?? "";

    return {
      results,
      finalOutput,
      totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
      strategy: this.name,
    };
  }
}
```

#### 5b. ParallelStrategy

```typescript
// src/multi-agent/strategies/parallel-strategy.ts

/**
 * 并行执行策略。
 * 所有 Agent 同时执行，结果汇总。
 *
 * 适用场景：独立任务并行处理，如 "同时查询天气、汇率、股价"
 */
export class ParallelStrategy implements OrchestrationStrategy {
  readonly name = "parallel";

  async execute(
    agents: AgentDefinition[],
    input: string,
    context: AgentRunContext,
    executor: AgentExecutor,
  ): Promise<OrchestrationResult> {
    const startTime = Date.now();

    // 并行执行所有 Agent
    const promises = agents.map(async (agent): Promise<SubAgentResult> => {
      const agentStart = Date.now();
      try {
        const result = await executor.runAgent(agent, input, context);
        const durationMs = Date.now() - agentStart;

        return {
          agentName: agent.name,
          status: result.status === "completed" ? "completed" : "failed",
          output: result.output,
          error: result.error?.message,
          durationMs,
          stateSummary: {
            steps: result.state.stepCount,
            toolCallsCount: result.state.messages.filter(
              (m) => m.role === "tool",
            ).length,
          },
        };
      } catch (error) {
        return {
          agentName: agent.name,
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
          durationMs: Date.now() - agentStart,
        };
      }
    });

    const results = await Promise.all(promises);

    // 汇总所有 Agent 的输出
    const finalOutput = results
      .map((r) => `【${r.agentName}】\n${r.output ?? r.error ?? "无输出"}`)
      .join("\n\n---\n\n");

    return {
      results,
      finalOutput,
      totalDurationMs: Date.now() - startTime,
      strategy: this.name,
    };
  }
}
```

#### 5c. PipelineStrategy

```typescript
// src/multi-agent/strategies/pipeline-strategy.ts

/**
 * 流水线策略。
 * 与 SequentialStrategy 类似，但支持自定义的中间转换函数。
 *
 * 每个 stage 可以定义一个 transform 函数，用于：
 * - 提取关键信息
 * - 格式化输出
 * - 添加额外上下文
 */
export interface PipelineStage {
  agent: AgentDefinition;
  /** 将上一个 stage 的输出转换为当前 stage 的输入 */
  transform?: (previousOutput: string, accumulatedContext: string[]) => string;
}

export class PipelineStrategy implements OrchestrationStrategy {
  readonly name = "pipeline";

  constructor(private readonly stages: PipelineStage[]) {}

  async execute(
    _agents: AgentDefinition[], // 不使用，使用 stages
    input: string,
    context: AgentRunContext,
    executor: AgentExecutor,
  ): Promise<OrchestrationResult> {
    const results: SubAgentResult[] = [];
    const accumulatedContext: string[] = [];
    let currentInput = input;

    for (const stage of this.stages) {
      // 应用转换函数
      if (stage.transform && accumulatedContext.length > 0) {
        currentInput = stage.transform(
          currentInput,
          accumulatedContext,
        );
      }

      const startTime = Date.now();
      const result = await executor.runAgent(stage.agent, currentInput, context);
      const durationMs = Date.now() - startTime;

      const subResult: SubAgentResult = {
        agentName: stage.agent.name,
        status: result.status === "completed" ? "completed" : "failed",
        output: result.output,
        error: result.error?.message,
        durationMs,
      };

      results.push(subResult);

      if (result.status !== "completed") {
        break;
      }

      accumulatedContext.push(result.output ?? "");
      currentInput = result.output ?? "";
    }

    const lastResult = results[results.length - 1];
    return {
      results,
      finalOutput: lastResult?.output ?? "",
      totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
      strategy: this.name,
    };
  }
}
```

#### 5d. RouterStrategy

```typescript
// src/multi-agent/strategies/router-strategy.ts

/**
 * 路由策略。
 * 使用 LLM 根据输入内容动态选择最合适的 Agent。
 *
 * 适用场景：客服系统、多领域助手、自动分发
 */
export class RouterStrategy implements OrchestrationStrategy {
  readonly name = "router";

  constructor(private readonly modelClient: ModelClient) {}

  async execute(
    agents: AgentDefinition[],
    input: string,
    context: AgentRunContext,
    executor: AgentExecutor,
  ): Promise<OrchestrationResult> {
    // 使用 LLM 选择最合适的 Agent
    const selectedAgent = await this.selectAgent(agents, input);

    const startTime = Date.now();
    const result = await executor.runAgent(selectedAgent, input, context);
    const durationMs = Date.now() - startTime;

    const subResult: SubAgentResult = {
      agentName: selectedAgent.name,
      status: result.status === "completed" ? "completed" : "failed",
      output: result.output,
      error: result.error?.message,
      durationMs,
    };

    return {
      results: [subResult],
      finalOutput: result.output ?? "",
      totalDurationMs: durationMs,
      strategy: this.name,
    };
  }

  private async selectAgent(
    agents: AgentDefinition[],
    input: string,
  ): Promise<AgentDefinition> {
    const agentList = agents
      .map((a, i) => `${i + 1}. ${a.name}: ${a.description}`)
      .join("\n");

    const response = await this.modelClient.generate({
      model: "openrouter:qwen/qwen3.6-plus-preview:free",
      systemPrompt: "你是一个路由器。根据用户输入选择最合适的 Agent。只回复 Agent 的名称，不要其他内容。",
      messages: [
        {
          id: "router",
          role: "user",
          content: `可选的 Agent:\n${agentList}\n\n用户输入: ${input}\n\n请选择最合适的 Agent（只回复名称）:`,
          createdAt: new Date().toISOString(),
        },
      ],
      tools: [],
    });

    if (response.type === "final") {
      const selectedName = response.output.trim();
      const matched = agents.find(
        (a) =>
          a.name === selectedName ||
          a.name.toLowerCase().includes(selectedName.toLowerCase()),
      );
      if (matched) return matched;
    }

    // 回退到第一个 Agent
    return agents[0]!;
  }
}
```

---

## 集成到 Runtime

### RuntimeConfig 扩展

```typescript
// runtime.ts
export interface RuntimeConfig {
  // ... 现有字段 ...
  /** Agent 注册表（启用多 Agent 模式） */
  agentRegistry?: AgentRegistry;
  /** 最大子 Agent 递归深度（默认 3） */
  maxAgentDepth?: number;
}
```

### SubAgentTool 自动注入

当 `RuntimeConfig.agentRegistry` 存在时，自动将 `SubAgentTool` 注入到工具列表：

```typescript
// runtime.ts constructor
constructor(config: RuntimeConfig) {
  // ... 现有逻辑 ...

  // 多 Agent 支持
  if (config.agentRegistry && config.agentRegistry.list().length > 0) {
    const subAgentTool = new SubAgentTool({
      registry: config.agentRegistry,
      modelClient: config.modelClient,
      maxDepth: config.maxAgentDepth ?? 3,
    });
    this.registry.register(subAgentTool as unknown as AgentTool);
  }
}
```

### EnterpriseAgentBase 扩展

```typescript
// base.ts
abstract class EnterpriseAgentBase {
  // 新增可选方法
  protected getAgentRegistry?(): AgentRegistry;
  protected getMaxAgentDepth?(): number;
}
```

### 流事件扩展

```typescript
// types.ts
export type AgentStreamEvent =
  | ... // 现有类型
  | { type: "sub_agent_started"; agentName: string; input: string }
  | { type: "sub_agent_completed"; agentName: string; output: string }
  | { type: "sub_agent_failed"; agentName: string; error: string };
```

### 审计事件扩展

```typescript
// types.ts
export type AuditEventType =
  | ... // 现有类型
  | "sub_agent_spawned"
  | "sub_agent_completed"
  | "sub_agent_failed";
```

---

## 测试策略

### 单元测试

| 测试文件 | 测试内容 |
|---------|---------|
| `test/agent-registry.test.ts` | 注册/查找/注销/重复注册 |
| `test/sub-agent-tool.test.ts` | mock Agent 执行、深度限制、错误处理 |
| `test/sequential-strategy.test.ts` | 顺序执行、中间失败中断、输出传递 |
| `test/parallel-strategy.test.ts` | 并行执行、部分失败、结果汇总 |
| `test/pipeline-strategy.test.ts` | transform 函数、上下文累积 |
| `test/router-strategy.test.ts` | mock LLM 路由决策、回退逻辑 |

### 集成测试

| 测试场景 | 验证点 |
|---------|--------|
| 主 Agent 调用子 Agent | 通过工具调用机制正确委派 |
| 嵌套调用（子 Agent 再派生） | 深度限制生效，不无限递归 |
| 并行多 Agent | 结果正确汇总，无竞态 |
| 流式模式下的子 Agent | stream 事件正确传播 |

---

## 实现优先级

1. **P0 — 必须实现**
   - `AgentDefinition` 类型
   - `AgentRegistry`
   - `SubAgentTool`（核心原语）
   - Runtime 自动注入
   - 深度限制防护

2. **P1 — 应该实现**
   - `SequentialStrategy`
   - `ParallelStrategy`
   - `AgentOrchestrator`

3. **P2 — 可以延后**
   - `PipelineStrategy`（自定义 transform）
   - `RouterStrategy`（需要额外 LLM 调用）
   - 流式子 Agent 事件

---

## 使用示例

### 示例 1：主 Agent + 子 Agent 工具委派

```typescript
const registry = new AgentRegistry();

registry.register({
  name: "code-reviewer",
  description: "代码审查专家",
  systemPrompt: "你是一个代码审查专家，负责审查代码质量。",
  tools: [readFileTool, searchTool],
  model: "openrouter:anthropic/claude-sonnet-4-20250514",
  maxSteps: 5,
});

registry.register({
  name: "test-generator",
  description: "测试生成专家",
  systemPrompt: "你是一个测试生成专家，为代码生成单元测试。",
  tools: [writeFileTool, runCommandTool],
  model: "openrouter:anthropic/claude-sonnet-4-20250514",
  maxSteps: 5,
});

// 主 Agent 自动获得 delegate_to_agent 工具
const agent = new MyAgent(modelClient, {
  agentRegistry: registry,
});
```

### 示例 2：编排器使用

```typescript
const orchestrator = new AgentOrchestrator({ registry, modelClient });

// 顺序执行：分析 → 生成测试 → 审查
const result = await orchestrator.sequential(
  ["code-analyzer", "test-generator", "code-reviewer"],
  "为 src/runtime.ts 生成完整的单元测试",
  context,
);
```
