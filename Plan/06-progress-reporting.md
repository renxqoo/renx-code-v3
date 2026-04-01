# 06 - 进度报告 (Progress Reporting)

## 问题陈述

当前 SDK 在工具执行期间没有进度反馈机制：

1. **用户感知空白** — 工具执行可能耗时数秒到数十秒，期间用户看不到任何进展
2. **无法估算剩余时间** — 没有进度百分比或 ETA 信息
3. **长时间操作无心跳** — 用户不知道 Agent 是在计算还是卡死了
4. **调试困难** — 无法知道工具执行到哪一步了

### 对标分析

| 能力 | Claude Code | renx-code-v3 当前 |
|------|------------|-------------------|
| 工具执行进度 | 有（progress events） | 无 |
| 步骤级进度 | 有（step X / total） | 无（仅 stepCount） |
| 自定义进度消息 | 有 | 无 |
| 进度取消 | 有（AbortSignal） | 有（但仅限 signal.aborted） |
| 心跳/保活 | 有 | 无 |

## 设计目标

1. **细粒度进度** — 每个工具可报告自己的进度（0-100%）
2. **步骤级汇总** — Agent 运行的整体进度（当前步骤 / 总步骤估算）
3. **自定义消息** — 工具可报告当前正在做什么
4. **流式集成** — 进度事件作为 AgentStreamEvent 的一部分
5. **零侵入** — 工具不实现进度接口也能正常工作

---

## 架构设计

### 新增文件清单

```
src/progress/
  index.ts                    — barrel export
  types.ts                    — 进度相关类型
  progress-reporter.ts        — 进度报告器
  step-estimator.ts           — 步骤估算器
```

---

## 详细设计

### 1. 类型定义

```typescript
// src/progress/types.ts

/**
 * 进度报告。
 */
export interface ProgressReport {
  /** 进度类型 */
  type: "tool_progress" | "step_progress" | "heartbeat";

  /** 进度百分比 (0-100)，-1 表示不确定 */
  percentage: number;

  /** 人类可读的进度消息 */
  message: string;

  /** 进度详情 */
  details?: Record<string, unknown>;

  /** 报告时间 */
  timestamp: string;
}

/**
 * 工具级进度报告。
 */
export interface ToolProgressReport extends ProgressReport {
  type: "tool_progress";

  /** 工具名称 */
  toolName: string;

  /** 工具调用 ID */
  toolCallId: string;
}

/**
 * 步骤级进度报告。
 */
export interface StepProgressReport extends ProgressReport {
  type: "step_progress";

  /** 当前步骤编号（从 1 开始） */
  currentStep: number;

  /** 预估总步骤数（-1 表示未知） */
  estimatedTotalSteps: number;

  /** 当前阶段的描述（如 "正在调用模型"、"正在执行工具"） */
  phase: "model_calling" | "tool_execution" | "initializing" | "finalizing";
}

/**
 * 心跳报告（保活信号）。
 */
export interface HeartbeatReport extends ProgressReport {
  type: "heartbeat";

  /** 距离上次活动的秒数 */
  idleSeconds: number;
}

/**
 * 进度回调函数。
 */
export type ProgressCallback = (report: ProgressReport) => void;

/**
 * 可报告进度的工具接口（可选实现）。
 */
export interface ProgressAwareTool {
  /**
   * 设置进度回调。
   * 工具在执行过程中通过此回调报告进度。
   */
  setProgressCallback?(callback: ProgressCallback): void;
}
```

### 2. ProgressReporter — 进度报告器

```typescript
// src/progress/progress-reporter.ts

/**
 * 进度报告器。
 *
 * 职责：
 * 1. 收集工具级进度报告
 * 2. 生成步骤级进度汇总
 * 3. 生成心跳信号
 * 4. 通过 AgentStreamEvent 向消费者传递
 *
 * 使用方式：
 * - 由 Runtime 创建并管理
 * - 在工具执行前注入到 ToolContext
 * - 工具可选择性地调用 reporter.report() 更新进度
 */
export class ProgressReporter {
  private readonly callbacks: ProgressCallback[] = [];
  private lastActivityTime = Date.now();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * 注册进度回调。
   */
  onProgress(callback: ProgressCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * 报告工具级进度。
   */
  reportToolProgress(
    toolName: string,
    toolCallId: string,
    percentage: number,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.lastActivityTime = Date.now();

    const report: ToolProgressReport = {
      type: "tool_progress",
      toolName,
      toolCallId,
      percentage,
      message,
      details,
      timestamp: new Date().toISOString(),
    };

    this.emit(report);
  }

  /**
   * 报告步骤级进度。
   */
  reportStepProgress(
    currentStep: number,
    estimatedTotal: number,
    phase: StepProgressReport["phase"],
    message: string,
  ): void {
    this.lastActivityTime = Date.now();

    const percentage = estimatedTotal > 0
      ? Math.round((currentStep / estimatedTotal) * 100)
      : -1;

    const report: StepProgressReport = {
      type: "step_progress",
      currentStep,
      estimatedTotalSteps: estimatedTotal,
      phase,
      percentage,
      message,
      timestamp: new Date().toISOString(),
    };

    this.emit(report);
  }

  /**
   * 启动心跳。
   * 定期发送保活信号，表示 Agent 仍在运行。
   *
   * @param intervalMs 心跳间隔（默认 5000ms）
   */
  startHeartbeat(intervalMs: number = 5_000): void {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      const idleSeconds = Math.round((Date.now() - this.lastActivityTime) / 1000);

      const report: HeartbeatReport = {
        type: "heartbeat",
        percentage: -1,
        message: `Agent 运行中（空闲 ${idleSeconds}s）`,
        idleSeconds,
        timestamp: new Date().toISOString(),
      };

      this.emit(report);
    }, intervalMs);
  }

  /**
   * 停止心跳。
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * 为特定工具调用创建一个绑定的进度回调。
   * 方便工具内部使用。
   */
  createToolProgressCallback(
    toolName: string,
    toolCallId: string,
  ): ProgressCallback {
    return (report) => {
      this.reportToolProgress(
        toolName,
        toolCallId,
        report.percentage,
        report.message,
        report.details,
      );
    };
  }

  /**
   * 重置（新 run 开始时调用）。
   */
  reset(): void {
    this.stopHeartbeat();
    this.lastActivityTime = Date.now();
  }

  private emit(report: ProgressReport): void {
    for (const cb of this.callbacks) {
      try {
        cb(report);
      } catch {
        // 回调错误不影响主流程
      }
    }
  }
}
```

### 3. StepEstimator — 步骤估算器

```typescript
// src/progress/step-estimator.ts

/**
 * 步骤估算器。
 *
 * 根据历史运行数据和当前输入，估算 Agent 运行的总步骤数。
 *
 * 估算策略：
 * 1. 基于历史平均值（如果有历史数据）
 * 2. 基于输入复杂度（消息数、是否包含工具）
 * 3. 基于模型行为模式（连续 tool_calls 的概率）
 */
export class StepEstimator {
  private readonly history: number[] = [];
  private readonly maxHistorySize: number;

  constructor(maxHistorySize: number = 20) {
    this.maxHistorySize = maxHistorySize;
  }

  /**
   * 记录一次运行的步骤数。
   */
  record(stepCount: number): void {
    this.history.push(stepCount);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }

  /**
   * 估算总步骤数。
   *
   * @returns 估算值，-1 表示无法估算
   */
  estimate(): number {
    if (this.history.length === 0) return -1;

    // 使用中位数（比平均值更稳定）
    const sorted = [...this.history].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 !== 0
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;

    return Math.ceil(median);
  }

  /**
   * 获取估算的置信度。
   * @returns 0-1，历史数据越多置信度越高
   */
  confidence(): number {
    return Math.min(this.history.length / this.maxHistorySize, 1);
  }
}
```

---

## 类型扩展

### AgentStreamEvent 扩展

```typescript
// src/types.ts

import type { ProgressReport } from "./progress/types";

export type AgentStreamEvent =
  | ... // 现有类型
  | { type: "progress"; report: ProgressReport };    // 新增
```

### ToolContext 扩展

```typescript
// src/tool/types.ts

export interface ToolContext {
  runContext: AgentRunContext;
  toolCall: ToolCall;
  backend: ExecutionBackend | undefined;
  metadata?: Metadata;

  /** 新增：进度回调（可选） */
  reportProgress?: (percentage: number, message: string) => void;
}
```

---

## 集成到 Runtime

### 修改 `src/runtime.ts`

```typescript
export interface RuntimeConfig {
  // ... 现有字段 ...
  /** 进度报告器（可选） */
  progressReporter?: ProgressReporter;
  /** 是否启用心跳（默认 false） */
  heartbeatEnabled?: boolean;
  /** 心跳间隔 ms（默认 5000） */
  heartbeatIntervalMs?: number;
}
```

#### 在 `run()` 方法中集成

```typescript
// run() 方法开始时
if (this.progressReporter) {
  this.progressReporter.reset();
  if (this.heartbeatEnabled) {
    this.progressReporter.startHeartbeat(this.heartbeatIntervalMs);
  }
}

// 每步循环开始时
this.progressReporter?.reportStepProgress(
  ctx.state.stepCount,
  this.stepEstimator.estimate(),
  "model_calling",
  `步骤 ${ctx.state.stepCount}：正在调用模型`,
);

// 工具执行前
this.progressReporter?.reportStepProgress(
  ctx.state.stepCount,
  this.stepEstimator.estimate(),
  "tool_execution",
  `步骤 ${ctx.state.stepCount}：正在执行工具 ${call.name}`,
);

// run() 方法结束时
this.progressReporter?.stopHeartbeat();
this.stepEstimator.record(ctx.state.stepCount);
```

#### 在 `stream()` 方法中集成

```typescript
// stream() 中的进度报告通过 yield 传递
// ProgressReporter 的回调中 yield progress event

if (this.progressReporter) {
  this.progressReporter.onProgress((report) => {
    // 注意：这里不能直接 yield，需要通过队列或标志位
    // 实际实现中，progressReporter 的回调将 report 存入队列
    // 在 stream() 的主循环中检查并 yield
  });
}

// 在 stream() 的适当位置 yield 进度事件
yield { type: "progress", report: stepReport };
```

#### 工具执行时注入进度回调

```typescript
// runtime.ts — 工具执行时构建 ToolContext
const toolCtx: ToolContext = {
  runContext: ctx,
  toolCall: call,
  backend: backend,
  metadata: {},
  reportProgress: this.progressReporter
    ? this.progressReporter.createToolProgressCallback(call.name, call.id)
    : undefined,
};
```

### 修改 `src/tool/executor.ts`

```typescript
// executor.ts — run() 方法中
// 将 ToolContext 中的 reportProgress 传递给工具

// 如果工具实现了 ProgressAwareTool 接口，注入回调
if (this.isProgressAware(tool) && ctx.reportProgress) {
  tool.setProgressCallback!(ctx.reportProgress);
}

const result = await tool.invoke(input, ctx);
```

---

## 进度感知工具示例

```typescript
/**
 * 一个报告进度的工具示例。
 */
const fileSearchTool: AgentTool = {
  name: "file_search",
  description: "在目录中搜索文件",
  inputSchema: { /* ... */ },

  async invoke(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { directory, pattern } = input as { directory: string; pattern: string };

    // 报告进度：开始搜索
    ctx.reportProgress?.(0, `开始在 ${directory} 中搜索 ${pattern}`);

    const files = await listFiles(directory);

    // 报告进度：发现 N 个文件
    ctx.reportProgress?.(30, `发现 ${files.length} 个文件，正在匹配...`);

    const matched = files.filter((f) => f.includes(pattern));

    // 报告进度：匹配完成
    ctx.reportProgress?.(90, `匹配完成，找到 ${matched.length} 个文件`);

    return {
      content: matched.join("\n"),
    };
  },
};
```

---

## 测试策略

### 单元测试

| 测试文件 | 测试内容 |
|---------|---------|
| `test/progress-reporter.test.ts` | 回调触发、心跳启停、工具进度回调创建 |
| `test/step-estimator.test.ts` | 估算准确性、置信度、历史记录 |

### 集成测试

| 测试场景 | 验证点 |
|---------|--------|
| 流式进度事件 | progress 事件正确 yield |
| 工具进度上报 | ProgressAwareTool 的进度正确传递 |
| 心跳保活 | 工具执行期间定期收到心跳 |
| 零侵入 | 普通工具（无进度）正常工作 |

---

## 实现优先级

1. **P0 — 必须实现**
   - `ProgressReporter`
   - `AgentStreamEvent` 扩展
   - `ToolContext` 扩展
   - Runtime 集成

2. **P1 — 应该实现**
   - `StepEstimator`
   - 心跳机制
   - 进度感知工具示例

3. **P2 — 可以延后**
   - 进度聚合（多个工具的进度合并）
   - ETA 估算
   - 进度持久化

---

## 使用示例

```typescript
// 监听进度事件
const stream = agent.stream({ inputText: "帮我查天气和汇率" });

for await (const event of stream) {
  switch (event.type) {
    case "progress":
      if (event.report.type === "tool_progress") {
        console.log(`  [${event.report.toolName}] ${event.report.percentage}% — ${event.report.message}`);
      } else if (event.report.type === "step_progress") {
        console.log(`  步骤 ${event.report.currentStep}/${event.report.estimatedTotalSteps} — ${event.report.message}`);
      }
      break;
    // ... 处理其他事件 ...
  }
}
```
