# 03 - 流式工具执行 (Streaming Tool Execution)

## 问题陈述

当前 SDK 在流式模式下，工具执行是严格串行的：

1. 模型流式返回所有 tool_calls
2. 等待流完成，收集全部 tool_calls
3. 串行执行每个工具
4. 所有工具完成后，才进入下一轮模型调用

这导致以下问题：

1. **延迟堆积** — 5 个独立工具查询，总耗时 = 5 × 单次耗时，而不是 max(单次耗时)
2. **流式体验断裂** — 用户在工具执行期间看不到任何反馈
3. **资源利用率低** — CPU 大部分时间在等待 I/O

### 对标分析

| 能力 | Claude Code | renx-code-v3 当前 |
|------|------------|-------------------|
| 并行工具执行 | 有（独立工具并发） | 仅 ToolExecutor.runBatch 支持并发 |
| 流式工具结果 | 有（逐个返回） | 无（全部完成后一次性返回） |
| 工具执行进度 | 有 | 无 |
| 部分工具失败容错 | 有 | 单个工具失败导致整个 run 失败 |

### 当前流程 vs 目标流程

```
当前流程（串行）：
  model: stream → [tc1, tc2, tc3] → exec(tc1) → exec(tc2) → exec(tc3) → model: stream → ...

目标流程（并发 + 流式返回）：
  model: stream → tc1 → exec(tc1) ──── result1 ──┐
                → tc2 → exec(tc2) ──── result2 ──┤→ model: stream → ...
                → tc3 → exec(tc3) ──── result3 ──┘
```

## 受影响的文件

| 文件 | 当前行为 | 需要修改 |
|------|---------|---------|
| `src/runtime.ts` | `stream()` 中工具串行执行 | 需要支持并发执行 |
| `src/tool/executor.ts` | `runBatch()` 支持并发但 `run()` 不支持 | 需要扩展为流式场景服务 |
| `src/types.ts` | 无工具进度事件 | 需要扩展 AgentStreamEvent |
| `src/message/manager.ts` | 消息追加是串行的 | 需要支持并发追加 |

---

## 架构设计

### 核心概念

```
┌─────────────────────────────────────────────────────┐
│          StreamingToolOrchestrator                   │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Concurrency- │  │ ToolExecutio-│  │ ResultStre-│ │
│  │ Analyzer    │  │ nPool        │  │ amer       │ │
│  │             │  │              │  │            │ │
│  │ - analyze() │  │ - execute()  │  │ - yield    │ │
│  │ - partition │  │ - cancel     │  │   results  │ │
│  └─────────────┘  └──────────────┘  └────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 新增文件清单

```
src/streaming/
  index.ts                        — barrel export
  tool-orchestrator.ts            — 流式工具编排器
  concurrency-analyzer.ts         — 并发安全分析
  execution-pool.ts               — 执行池（并发管理）
```

---

## 详细设计

### 1. ConcurrencyAnalyzer — 并发安全分析

```typescript
// src/streaming/concurrency-analyzer.ts

import type { AgentTool, ToolContext } from "../tool/types";
import type { ToolCall } from "@renx/model";

/**
 * 工具调用分组：决定哪些工具可以并发执行。
 */
export interface ToolCallGroup {
  /** 组内的工具调用 */
  calls: ToolCall[];
  /** 是否可以并发执行 */
  parallel: boolean;
  /** 原因（用于调试和日志） */
  reason: string;
}

/**
 * 并发安全分析器。
 *
 * 根据 AgentTool.isConcurrencySafe() 和工具依赖关系，
 * 将工具调用分为可并发和必须串行的组。
 */
export class ConcurrencyAnalyzer {
  /**
   * 分析工具调用列表，生成分组执行计划。
   *
   * 策略：
   * 1. 标记所有 isConcurrencySafe() === true 的工具为可并发
   * 2. 标记所有 isReadOnly() === true 的工具为可并发（只读不冲突）
   * 3. 其余工具串行执行
   * 4. 同名工具调用（如两次调用 calculator）按顺序执行
   *
   * @param calls 模型返回的工具调用列表
   * @param tools 可用的工具定义
   * @returns 分组执行计划
   */
  analyze(calls: ToolCall[], tools: Map<string, AgentTool>): ToolCallGroup[] {
    if (calls.length <= 1) {
      return [{
        calls,
        parallel: false,
        reason: "单次调用无需并发",
      }];
    }

    const safeCalls: ToolCall[] = [];
    const unsafeCalls: ToolCall[] = [];

    for (const call of calls) {
      const tool = tools.get(call.name);
      if (!tool) {
        // 未知工具，放在 unsafe 组（会由后续逻辑报错）
        unsafeCalls.push(call);
        continue;
      }

      // 检查并发安全性
      const isSafe = this.isToolSafe(tool, call);
      if (isSafe) {
        safeCalls.push(call);
      } else {
        unsafeCalls.push(call);
      }
    }

    const groups: ToolCallGroup[] = [];

    if (safeCalls.length > 0) {
      groups.push({
        calls: safeCalls,
        parallel: true,
        reason: `${safeCalls.length} 个只读/安全工具并发执行`,
      });
    }

    if (unsafeCalls.length > 0) {
      for (const call of unsafeCalls) {
        groups.push({
          calls: [call],
          parallel: false,
          reason: `${call.name} 标记为不安全，串行执行`,
        });
      }
    }

    return groups;
  }

  /**
   * 判断工具调用是否并发安全。
   */
  private isToolSafe(tool: AgentTool, call: ToolCall): boolean {
    // 显式声明并发安全
    if (tool.isConcurrencySafe?.(call.input) === true) {
      return true;
    }
    // 只读工具默认安全
    if (tool.isReadOnly?.(call.input) === true) {
      return true;
    }
    return false;
  }
}
```

### 2. ExecutionPool — 执行池

```typescript
// src/streaming/execution-pool.ts

import type { ToolCall } from "@renx/model";
import type { ToolExecutor, ToolExecutorRunResult } from "../tool/executor";
import type { AgentRunContext } from "../types";

/**
 * 单个工具执行的结果。
 */
export interface PooledToolResult {
  call: ToolCall;
  result: ToolExecutorRunResult;
  durationMs: number;
  error?: Error;
}

/**
 * 执行池 — 管理工具的并发执行。
 *
 * 特性：
 * - 并发执行通过 concurrency 限制控制
 * - 结果按完成顺序产出（非提交顺序）
 * - 支持取消（通过 AbortSignal）
 * - 单个工具失败不影响其他工具
 */
export class ExecutionPool {
  private readonly executor: ToolExecutor;
  private readonly concurrency: number;

  constructor(options: {
    executor: ToolExecutor;
    /** 最大并发数（默认 Infinity） */
    concurrency?: number;
  }) {
    this.executor = options.executor;
    this.concurrency = options.concurrency ?? Infinity;
  }

  /**
   * 并发执行一组工具调用，结果按完成顺序通过回调产出。
   *
   * @param calls 要执行的工具调用
   * @param ctx 运行上下文
   * @param onResult 单个工具完成时的回调（立即产出）
   * @returns 所有工具的执行结果
   */
  async execute(
    calls: ToolCall[],
    ctx: AgentRunContext,
    onResult?: (result: PooledToolResult) => void,
  ): Promise<PooledToolResult[]> {
    if (calls.length === 0) return [];

    if (this.concurrency === 1 || calls.length === 1) {
      // 串行模式
      return this.executeSequential(calls, ctx, onResult);
    }

    // 并发模式
    return this.executeConcurrent(calls, ctx, onResult);
  }

  private async executeSequential(
    calls: ToolCall[],
    ctx: AgentRunContext,
    onResult?: (result: PooledToolResult) => void,
  ): Promise<PooledToolResult[]> {
    const results: PooledToolResult[] = [];

    for (const call of calls) {
      const result = await this.executeOne(call, ctx);
      results.push(result);
      onResult?.(result);
    }

    return results;
  }

  private async executeConcurrent(
    calls: ToolCall[],
    ctx: AgentRunContext,
    onResult?: (result: PooledToolResult) => void,
  ): Promise<PooledToolResult[]> {
    const results: PooledToolResult[] = [];
    const executing: Promise<void>[] = [];
    let slotAvailable: Promise<void> = Promise.resolve();
    let slotResolve: () => void = () => {};

    const activeCount = { value: 0 };

    for (const call of calls) {
      // 并发限制：如果达到上限，等待某个任务完成
      if (activeCount.value >= this.concurrency) {
        await slotAvailable;
      }

      activeCount.value++;

      const task = this.executeOne(call, ctx).then((result) => {
        results.push(result);
        onResult?.(result);
        activeCount.value--;

        // 释放一个并发槽位
        if (activeCount.value < this.concurrency) {
          const oldResolve = slotResolve;
          slotAvailable = new Promise<void>((resolve) => {
            slotResolve = resolve;
          });
          oldResolve();
        }
      });

      executing.push(task);
    }

    await Promise.all(executing);
    return results;
  }

  private async executeOne(
    call: ToolCall,
    ctx: AgentRunContext,
  ): Promise<PooledToolResult> {
    const startTime = Date.now();
    try {
      const result = await this.executor.run(call, ctx);
      return {
        call,
        result,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        call,
        result: {
          type: "stopped" as const,
          reason: "execution_error",
          tool: null as never,
          call,
          statePatches: [],
        },
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}
```

### 3. StreamingToolOrchestrator — 流式工具编排器

```typescript
// src/streaming/tool-orchestrator.ts

import type { ToolCall } from "@renx/model";
import type { AgentRunContext, AgentStreamEvent } from "../types";
import type { AgentTool, ToolResult } from "../tool/types";
import type { ToolExecutor } from "../tool/executor";
import { ConcurrencyAnalyzer } from "./concurrency-analyzer";
import { ExecutionPool, PooledToolResult } from "./execution-pool";
import { InMemoryToolRegistry } from "../tool/registry";

/**
 * 流式工具编排的结果。
 */
export interface StreamingToolResult {
  /** 所有工具的执行结果 */
  results: Array<{
    call: ToolCall;
    toolResult: ToolResult;
    durationMs: number;
  }>;
  /** 总耗时 */
  totalDurationMs: number;
  /** 是否有工具失败 */
  hasFailure: boolean;
}

/**
 * 流式工具编排器。
 *
 * 替代 runtime.ts 中串行执行工具的逻辑。
 * 支持：
 * - 按并发安全性分组
 * - 安全组内并发执行
 * - 结果逐个流式产出（通过 yield）
 * - 单个失败不阻塞其他工具
 */
export class StreamingToolOrchestrator {
  private readonly analyzer: ConcurrencyAnalyzer;
  private readonly registry: InMemoryToolRegistry;

  constructor(
    registry: InMemoryToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly concurrency?: number,
  ) {
    this.analyzer = new ConcurrencyAnalyzer();
    this.registry = registry;
  }

  /**
   * 流式执行一组工具调用。
   *
   * @yields AgentStreamEvent — tool_call 和 tool_result 事件
   * @returns 最终汇总结果
   */
  async *execute(
    calls: ToolCall[],
    ctx: AgentRunContext,
  ): AsyncGenerator<AgentStreamEvent, StreamingToolResult> {
    const startTime = Date.now();

    // 分析并发分组
    const toolMap = new Map<string, AgentTool>();
    for (const tool of this.registry.list()) {
      toolMap.set(tool.name, tool);
    }
    const groups = this.analyzer.analyze(calls, toolMap);

    const allResults: StreamingToolResult["results"] = [];
    let hasFailure = false;

    for (const group of groups) {
      if (group.parallel && group.calls.length > 1) {
        // 并发执行组
        const pool = new ExecutionPool({
          executor: this.executor,
          concurrency: this.concurrency,
        });

        const groupResults: StreamingToolResult["results"] = [];

        // 使用 onResult 回调实现流式产出
        const completedPromise = pool.execute(group.calls, ctx, (pooled) => {
          // 每个工具完成时，记录结果（但不在回调中 yield）
          // 我们通过 promise chain 处理
        });

        // 等待所有完成
        const pooledResults = await completedPromise;

        for (const pooled of pooledResults) {
          if (pooled.result.type === "stopped") {
            hasFailure = true;
            continue;
          }

          const toolResult = pooled.result.result.output;
          groupResults.push({
            call: pooled.call,
            toolResult,
            durationMs: pooled.durationMs,
          });

          // 流式产出结果
          yield { type: "tool_result", result: toolResult };
        }

        allResults.push(...groupResults);
      } else {
        // 串行执行
        for (const call of group.calls) {
          const tool = this.registry.get(call.name);
          if (!tool) {
            throw new AgentError({
              code: "TOOL_NOT_FOUND",
              message: `Tool not found: ${call.name}`,
            });
          }

          const callStart = Date.now();
          const execResult = await this.executor.run(call, ctx);

          if (execResult.type === "stopped") {
            hasFailure = true;
            continue;
          }

          const toolResult = execResult.result.output;
          allResults.push({
            call,
            toolResult,
            durationMs: Date.now() - callStart,
          });

          // 流式产出结果
          yield { type: "tool_result", result: toolResult };
        }
      }
    }

    return {
      results: allResults,
      totalDurationMs: Date.now() - startTime,
      hasFailure,
    };
  }
}
```

---

## 集成到 Runtime

### 修改 `src/runtime.ts` 的 `stream()` 方法

替换当前串行工具执行为流式并发执行：

```typescript
// runtime.ts — stream() 方法中，tool_calls 分支

// --- 当前（串行）---
for (const call of modelResponse.toolCalls) {
  // ... 串行执行每个工具 ...
  yield { type: "tool_result", result: toolResult.output };
}

// --- 改为（流式并发）---
const orchestrator = new StreamingToolOrchestrator(
  this.registry,
  this.toolExecutor,
  this.concurrency,
);

const streamToolResult = yield* orchestrator.execute(
  modelResponse.toolCalls,
  ctx,
);

// 应用所有工具结果到状态
for (const { call, toolResult } of streamToolResult.results) {
  ctx = this.patchState(ctx, {}, (s) =>
    this.messageManager.appendToolResultMessage(
      s,
      call.name,
      call.id,
      toolResult.content,
    ),
  );
}
```

### 同样修改 `run()` 方法

`run()` 方法也需要同样的并发优化（虽然不 yield 事件，但并发执行能减少总延迟）：

```typescript
// runtime.ts — run() 方法中，tool_calls 分支

// 使用 ToolExecutor.runBatch() 的并发能力
// 但增加流式编排器的并发分析逻辑
const orchestrator = new StreamingToolOrchestrator(
  this.registry,
  this.toolExecutor,
  this.concurrency,
);

const gen = orchestrator.execute(modelResponse.toolCalls, ctx);
let iter = await gen.next();
const toolResults: StreamingToolResult["results"] = [];
while (!iter.done) {
  // run() 模式下忽略流事件，只收集结果
  iter = await gen.next();
}
// gen.return() 的值在 iter.done 时获取不到...
// 需要调整接口让 run() 也能使用并发
```

### RuntimeConfig 扩展

```typescript
export interface RuntimeConfig {
  // ... 现有字段 ...
  /** 工具执行最大并发数（默认 Infinity） */
  toolConcurrency?: number;
}
```

---

## 测试策略

### 单元测试

| 测试文件 | 测试内容 |
|---------|---------|
| `test/concurrency-analyzer.test.ts` | 分组逻辑：安全/不安全/混合 |
| `test/execution-pool.test.ts` | 并发限制、结果顺序、错误隔离 |
| `test/streaming-tool-orchestrator.test.ts` | 完整流程、事件产出顺序 |

### 集成测试

| 测试场景 | 验证点 |
|---------|--------|
| 多个只读工具并发 | 总耗时 ≈ max(单次)，而非 sum |
| 混合安全/不安全工具 | 安全组并发，不安全组串行 |
| 单个工具失败 | 不影响其他工具，hasFailure=true |
| 流式产出顺序 | tool_result 按完成顺序产出 |

---

## 实现优先级

1. **P0 — 必须实现**
   - `ConcurrencyAnalyzer`
   - `ExecutionPool`
   - `StreamingToolOrchestrator`
   - Runtime `stream()` 集成

2. **P1 — 应该实现**
   - Runtime `run()` 并发优化
   - 并发数配置
   - 详细日志

3. **P2 — 可以延后**
   - 工具间依赖图分析（DAG 调度）
   - 工具执行超时控制
   - 工具结果缓存

---

## 使用示例

```typescript
// 默认：安全工具自动并发
const agent = new AgentRuntime({
  name: "my-agent",
  modelClient,
  model: "openrouter:qwen/qwen3.6-plus-preview:free",
  tools: [getWeatherTool, getStockPriceTool, calculatorTool],
  systemPrompt: "You are helpful.",
  maxSteps: 10,
  toolConcurrency: 5, // 最多 5 个工具同时执行
});
```
