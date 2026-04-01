# 04 - 错误恢复机制 (Error Recovery)

## 问题陈述

当前 SDK 的错误处理是「捕获 → 记录 → 失败」模式，缺乏恢复能力：

1. **模型输出截断** — 模型输出被 `maxTokens` 截断时，直接作为 `final` 返回，内容不完整
2. **上下文溢出** — `CONTEXT_OVERFLOW` 错误导致运行立即失败，无自动恢复
3. **模型不可用** — 无降级策略，单点失败
4. **工具失败** — 单个工具失败导致整个 run 失败
5. **网络抖动** — 虽然有模型层重试，但 agent 层无恢复策略

### 对标分析

| 能力 | Claude Code | renx-code-v3 当前 |
|------|------------|-------------------|
| 输出截断恢复 | 有（检测 incomplete，追加继续） | 无 |
| 上下文溢出恢复 | 有（reactive compact + 重试） | 无 |
| 模型降级 | 有（fallback model） | 仅 @renx/model 有，agent 层未使用 |
| 工具失败容错 | 有（继续执行，报告错误） | 单个失败 = run 失败 |
| 自定义恢复策略 | 有（可配置） | 无 |

## 受影响的文件

| 文件 | 当前行为 | 需要修改 |
|------|---------|---------|
| `src/runtime.ts` | 错误直接导致 run 失败 | 需要集成 RecoveryManager |
| `src/types.ts` | `RecoveryConfig` 已定义但空 | 需要扩展 |
| `src/errors.ts` | 错误码已定义但无恢复关联 | 需要增加恢复元数据 |
| `src/tool/executor.ts` | 工具失败直接抛出 | 需要可选的容错模式 |

---

## 架构设计

### 核心概念

```
┌─────────────────────────────────────────────────────┐
│              RecoveryManager                         │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ RecoveryStr-│  │ OutputTrunc- │  │ ContextOver│ │
│  │ ategy       │  │ ationRecover │  │ flowRecovr │ │
│  │             │  │              │  │            │ │
│  │ - shouldRe- │  │ - detect     │  │ - detect   │ │
│  │   cover()   │  │ - recover    │  │ - compact  │ │
│  │ - recover() │  │              │  │ - retry    │ │
│  └─────────────┘  └──────────────┘  └────────────┘ │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐                  │
│  │ ToolFailure │  │ ModelFallba- │                  │
│  │ Recovery    │  │ ckRecovery   │                  │
│  └─────────────┘  └──────────────┘                  │
└─────────────────────────────────────────────────────┘
```

### 新增文件清单

```
src/recovery/
  index.ts                    — barrel export
  types.ts                    — 恢复相关类型定义
  recovery-manager.ts         — 恢复管理器
  strategies/
    output-truncation.ts      — 输出截断恢复
    context-overflow.ts       — 上下文溢出恢复
    model-fallback.ts         — 模型降级恢复
    tool-failure.ts           — 工具失败容错
```

---

## 详细设计

### 1. 类型定义

```typescript
// src/recovery/types.ts

import type { AgentError } from "../errors";
import type { AgentRunContext, AgentState } from "../types";
import type { ModelResponse, ModelRequest } from "@renx/model";

/**
 * 恢复动作类型。
 */
export type RecoveryAction =
  | { type: "retry"; description: string }
  | { type: "retry_with_compact"; description: string }
  | { type: "retry_with_fallback_model"; description: string; fallbackModel: string }
  | { type: "continue_with_partial"; description: string; partialResult: ModelResponse }
  | { type: "skip_tool"; description: string }
  | { type: "abort"; description: string };

/**
 * 恢复策略的决策结果。
 */
export interface RecoveryDecision {
  /** 是否可以恢复 */
  recoverable: boolean;
  /** 恢复动作 */
  action: RecoveryAction;
  /** 恢复尝试次数（累计） */
  attempt: number;
  /** 最大恢复尝试次数 */
  maxAttempts: number;
}

/**
 * 恢复上下文，传递给各恢复策略。
 */
export interface RecoveryContext {
  /** 当前 agent 运行上下文 */
  runContext: AgentRunContext;
  /** 触发恢复的错误 */
  error: AgentError;
  /** 当前恢复尝试次数 */
  attempt: number;
  /** 模型请求（可能用于修改后重试） */
  modelRequest?: ModelRequest;
  /** 模型响应（可能包含部分结果） */
  modelResponse?: ModelResponse;
}

/**
 * 恢复策略接口。
 */
export interface RecoveryStrategy {
  /** 策略名称 */
  readonly name: string;

  /**
   * 判断是否可以处理该错误。
   */
  canHandle(error: AgentError): boolean;

  /**
   * 决定恢复动作。
   */
  decide(context: RecoveryContext): RecoveryDecision | Promise<RecoveryDecision>;

  /**
   * 执行恢复动作，返回修改后的上下文。
   */
  recover(
    context: RecoveryContext,
    decision: RecoveryDecision,
  ): Promise<RecoveryResult>;
}

/**
 * 恢复结果。
 */
export interface RecoveryResult {
  /** 是否恢复成功 */
  recovered: boolean;
  /** 修改后的状态（如果需要） */
  statePatch?: Partial<AgentState>;
  /** 修改后的模型请求（如果需要重试） */
  modifiedRequest?: ModelRequest;
  /** 恢复消息（用于审计和调试） */
  message: string;
}

/**
 * 恢复管理器配置。
 */
export interface RecoveryManagerConfig {
  /** 输出截断恢复配置 */
  outputTruncation?: {
    /** 最大恢复次数（默认 2） */
    maxAttempts?: number;
  };

  /** 上下文溢出恢复配置 */
  contextOverflow?: {
    /** 最大恢复次数（默认 2） */
    maxAttempts?: number;
    /** 压缩后重试 */
    compactAndRetry?: boolean;
  };

  /** 模型降级配置 */
  modelFallback?: {
    /** 降级模型列表（按优先级） */
    fallbackModels?: string[];
    /** 最大降级次数（默认 1） */
    maxFallbacks?: number;
  };

  /** 工具失败容错配置 */
  toolFailure?: {
    /** 是否启用工具级容错（默认 false） */
    enabled?: boolean;
    /** 最大连续失败次数（默认 3） */
    maxConsecutiveFailures?: number;
  };
}
```

### 2. RecoveryManager — 恢复管理器

```typescript
// src/recovery/recovery-manager.ts

/**
 * 恢复管理器。
 *
 * 统一管理所有恢复策略，按优先级尝试恢复。
 *
 * 恢复流程：
 * 1. 错误发生 → RecoveryManager.shouldRecover()
 * 2. 匹配恢复策略 → strategy.decide()
 * 3. 执行恢复动作 → strategy.recover()
 * 4. 根据恢复结果决定是否重试
 */
export class RecoveryManager {
  private readonly strategies: RecoveryStrategy[] = [];
  private readonly config: RecoveryManagerConfig;
  private readonly attemptCounts = new Map<string, number>();

  constructor(config: RecoveryManagerConfig) {
    this.config = config;

    // 注册内置恢复策略（按优先级排序）
    if (config.outputTruncation) {
      this.strategies.push(new OutputTruncationRecovery(config.outputTruncation));
    }
    if (config.contextOverflow) {
      this.strategies.push(new ContextOverflowRecovery(config.contextOverflow));
    }
    if (config.modelFallback) {
      this.strategies.push(new ModelFallbackRecovery(config.modelFallback));
    }
    if (config.toolFailure?.enabled) {
      this.strategies.push(new ToolFailureRecovery(config.toolFailure));
    }
  }

  /**
   * 注册自定义恢复策略。
   */
  registerStrategy(strategy: RecoveryStrategy): void {
    this.strategies.push(strategy);
  }

  /**
   * 判断是否可以恢复该错误。
   */
  canRecover(error: AgentError): boolean {
    return this.strategies.some((s) => s.canHandle(error));
  }

  /**
   * 执行恢复。
   *
   * @returns 恢复结果，或 null 表示无法恢复
   */
  async recover(context: RecoveryContext): Promise<RecoveryResult | null> {
    for (const strategy of this.strategies) {
      if (!strategy.canHandle(context.error)) continue;

      // 检查尝试次数
      const key = `${strategy.name}:${context.error.code}`;
      const attempts = this.attemptCounts.get(key) ?? 0;

      const decision = await strategy.decide({
        ...context,
        attempt: attempts,
      });

      if (!decision.recoverable || decision.attempt >= decision.maxAttempts) {
        continue;
      }

      // 执行恢复
      const result = await strategy.recover(context, decision);

      // 更新尝试计数
      this.attemptCounts.set(key, attempts + 1);

      if (result.recovered) {
        return result;
      }
    }

    return null;
  }

  /**
   * 重置恢复计数器（新 run 开始时调用）。
   */
  reset(): void {
    this.attemptCounts.clear();
  }
}
```

### 3. 恢复策略实现

#### 3a. OutputTruncationRecovery — 输出截断恢复

```typescript
// src/recovery/strategies/output-truncation.ts

/**
 * 输出截断恢复策略。
 *
 * 当模型输出因 maxTokens 限制被截断时：
 * 1. 检测截断（finish_reason = "length" 或输出明显不完整）
 * 2. 发送 "请继续" 消息让模型补全
 * 3. 合并多次输出
 *
 * 这是最常见且最容易恢复的错误类型。
 */
export class OutputTruncationRecovery implements RecoveryStrategy {
  readonly name = "output-truncation";
  private readonly maxAttempts: number;

  constructor(config: { maxAttempts?: number }) {
    this.maxAttempts = config.maxAttempts ?? 2;
  }

  canHandle(error: AgentError): boolean {
    // 模型层会将截断转为特定错误码
    return error.code === "MAX_OUTPUT_TOKENS" ||
           error.code === "OUTPUT_TRUNCATED" ||
           (error.code === "MODEL_ERROR" &&
            error.message.toLowerCase().includes("length"));
  }

  decide(context: RecoveryContext): RecoveryDecision {
    return {
      recoverable: context.attempt < this.maxAttempts,
      action: { type: "retry", description: "追加「请继续」消息让模型补全输出" },
      attempt: context.attempt,
      maxAttempts: this.maxAttempts,
    };
  }

  async recover(
    context: RecoveryContext,
    _decision: RecoveryDecision,
  ): Promise<RecoveryResult> {
    const lastResponse = context.modelResponse;

    // 检查是否有部分输出可以继续
    if (lastResponse?.type === "final" && lastResponse.output) {
      const partialOutput = lastResponse.output;

      return {
        recovered: true,
        statePatch: undefined,
        modifiedRequest: {
          ...(context.modelRequest ?? {}),
          messages: [
            ...(context.modelRequest?.messages ?? []),
            // 追加 assistant 的部分输出
            {
              id: `truncated_${Date.now()}`,
              role: "assistant" as const,
              content: partialOutput,
              createdAt: new Date().toISOString(),
            },
            // 追加 "请继续"
            {
              id: `continue_${Date.now()}`,
              role: "user" as const,
              content: "你的回答被截断了，请从上次中断的地方继续。",
              createdAt: new Date().toISOString(),
            },
          ],
        },
        message: `输出截断恢复：已追加继续消息（已输出 ${partialOutput.length} 字符）`,
      };
    }

    return {
      recovered: false,
      message: "无法恢复：没有部分输出可用",
    };
  }
}
```

#### 3b. ContextOverflowRecovery — 上下文溢出恢复

```typescript
// src/recovery/strategies/context-overflow.ts

/**
 * 上下文溢出恢复策略。
 *
 * 当模型 API 返回 CONTEXT_OVERFLOW 错误时：
 * 1. 检测溢出
 * 2. 触发上下文压缩（依赖 ContextWindowManager）
 * 3. 用压缩后的消息重试
 *
 * 依赖：需要 Context Window Management 功能（Plan 01）
 */
export class ContextOverflowRecovery implements RecoveryStrategy {
  readonly name = "context-overflow";
  private readonly maxAttempts: number;
  private readonly compactAndRetry: boolean;

  constructor(config: { maxAttempts?: number; compactAndRetry?: boolean }) {
    this.maxAttempts = config.maxAttempts ?? 2;
    this.compactAndRetry = config.compactAndRetry ?? true;
  }

  canHandle(error: AgentError): boolean {
    return error.code === "CONTEXT_OVERFLOW" ||
           error.code === "PROMPT_TOO_LONG" ||
           (error.code === "MODEL_ERROR" &&
            (error.message.toLowerCase().includes("context length") ||
             error.message.toLowerCase().includes("token limit")));
  }

  decide(context: RecoveryContext): RecoveryDecision {
    if (!this.compactAndRetry) {
      return {
        recoverable: false,
        action: { type: "abort", description: "上下文溢出恢复未启用" },
        attempt: context.attempt,
        maxAttempts: this.maxAttempts,
      };
    }

    return {
      recoverable: context.attempt < this.maxAttempts,
      action: {
        type: "retry_with_compact",
        description: "压缩上下文后重试",
      },
      attempt: context.attempt,
      maxAttempts: this.maxAttempts,
    };
  }

  async recover(
    context: RecoveryContext,
    _decision: RecoveryDecision,
  ): Promise<RecoveryResult> {
    const messages = context.runContext.state.messages;

    // 简单策略：移除最早的一半消息
    // 生产环境应使用 ContextWindowManager.compact()
    const halfPoint = Math.floor(messages.length / 2);
    const retained = messages.slice(halfPoint);

    // 确保不截断工具调用对
    const safeRetained = this.ensureSafeCut(retained);

    return {
      recovered: true,
      statePatch: {
        messages: safeRetained,
      } as any, // 通过 state patch 机制
      modifiedRequest: {
        ...(context.modelRequest ?? {}),
        messages: context.modelRequest?.messages?.slice(-safeRetained.length) ?? [],
      },
      message: `上下文溢出恢复：从 ${messages.length} 条消息压缩到 ${safeRetained.length} 条`,
    };
  }

  private ensureSafeCut(messages: import("../types").RunMessage[]): import("../types").RunMessage[] {
    // 找到第一个非 tool 消息的位置
    let start = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role !== "tool") {
        start = i;
        break;
      }
    }
    return messages.slice(start);
  }
}
```

#### 3c. ModelFallbackRecovery — 模型降级恢复

```typescript
// src/recovery/strategies/model-fallback.ts

/**
 * 模型降级恢复策略。
 *
 * 当主模型不可用时，依次尝试降级模型。
 *
 * 典型降级链：
 *   claude-opus → claude-sonnet → gpt-4o → gpt-4o-mini
 *
 * 依赖：@renx/model 已有 selectFallbackModel 重试模式
 * 这里在 agent 层提供额外的降级控制
 */
export class ModelFallbackRecovery implements RecoveryStrategy {
  readonly name = "model-fallback";
  private readonly fallbackModels: string[];
  private readonly maxFallbacks: number;
  private currentFallbackIndex = 0;

  constructor(config: {
    fallbackModels?: string[];
    maxFallbacks?: number;
  }) {
    this.fallbackModels = config.fallbackModels ?? [];
    this.maxFallbacks = config.maxFallbacks ?? 1;
  }

  canHandle(error: AgentError): boolean {
    // 模型不可用：服务端错误、超时、过载
    return error.code === "MODEL_ERROR" ||
           error.code === "MODEL_OVERLOADED" ||
           error.code === "SERVER_ERROR" ||
           error.code === "TIMEOUT" ||
           error.code === "RATE_LIMIT";
  }

  decide(context: RecoveryContext): RecoveryDecision {
    if (this.currentFallbackIndex >= this.fallbackModels.length ||
        this.currentFallbackIndex >= this.maxFallbacks) {
      return {
        recoverable: false,
        action: { type: "abort", description: "已尝试所有降级模型" },
        attempt: context.attempt,
        maxAttempts: this.maxFallbacks,
      };
    }

    const fallbackModel = this.fallbackModels[this.currentFallbackIndex]!;
    return {
      recoverable: true,
      action: {
        type: "retry_with_fallback_model",
        description: `切换到降级模型: ${fallbackModel}`,
        fallbackModel,
      },
      attempt: context.attempt,
      maxAttempts: this.maxFallbacks,
    };
  }

  async recover(
    context: RecoveryContext,
    decision: RecoveryDecision,
  ): Promise<RecoveryResult> {
    if (decision.action.type !== "retry_with_fallback_model") {
      return { recovered: false, message: "无效的恢复动作" };
    }

    this.currentFallbackIndex++;

    return {
      recovered: true,
      modifiedRequest: {
        ...(context.modelRequest ?? {}),
        model: decision.action.fallbackModel,
      },
      message: `模型降级恢复：从 ${context.modelRequest?.model ?? "unknown"} 切换到 ${decision.action.fallbackModel}`,
    };
  }

  reset(): void {
    this.currentFallbackIndex = 0;
  }
}
```

#### 3d. ToolFailureRecovery — 工具失败容错

```typescript
// src/recovery/strategies/tool-failure.ts

/**
 * 工具失败容错策略。
 *
 * 当前行为：单个工具失败 → 整个 run 失败
 * 目标行为：单个工具失败 → 记录错误，返回错误结果给模型，继续执行
 *
 * 让模型自己决定如何处理工具失败，而不是直接 abort 整个 run。
 */
export class ToolFailureRecovery implements RecoveryStrategy {
  readonly name = "tool-failure";
  private readonly maxConsecutiveFailures: number;
  private consecutiveFailures = 0;

  constructor(config: { maxConsecutiveFailures?: number }) {
    this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
  }

  canHandle(error: AgentError): boolean {
    return error.code === "TOOL_ERROR";
  }

  decide(context: RecoveryContext): RecoveryDecision {
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      return {
        recoverable: false,
        action: {
          type: "abort",
          description: `连续 ${this.consecutiveFailures} 次工具失败，终止运行`,
        },
        attempt: this.consecutiveFailures,
        maxAttempts: this.maxConsecutiveFailures,
      };
    }

    return {
      recoverable: true,
      action: {
        type: "skip_tool",
        description: "跳过失败工具，返回错误信息给模型",
      },
      attempt: this.consecutiveFailures,
      maxAttempts: this.maxConsecutiveFailures,
    };
  }

  async recover(
    context: RecoveryContext,
    _decision: RecoveryDecision,
  ): Promise<RecoveryResult> {
    this.consecutiveFailures++;

    return {
      recovered: true,
      message: `工具失败容错：跳过失败工具（连续失败 ${this.consecutiveFailures}/${this.maxConsecutiveFailures}）`,
      // 工具执行层面处理：返回错误消息作为 tool result
    };
  }

  /** 工具成功时重置计数器 */
  onSuccess(): void {
    this.consecutiveFailures = 0;
  }
}
```

---

## 集成到 Runtime

### 修改 `src/runtime.ts`

```typescript
export interface RuntimeConfig {
  // ... 现有字段 ...
  /** 错误恢复管理器（可选） */
  recovery?: RecoveryManager;
}
```

#### 在 `run()` 方法中集成

```typescript
// runtime.ts — run() 方法的 catch 块

} catch (error) {
  const agentError = /* ... normalize ... */;

  // --- 新增：尝试恢复 ---
  if (this.recovery) {
    const recoveryContext: RecoveryContext = {
      runContext: ctx,
      error: agentError,
      attempt: 0,
      modelRequest: lastModelRequest,
      modelResponse: lastModelResponse,
    };

    const recoveryResult = await this.recovery.recover(recoveryContext);

    if (recoveryResult?.recovered) {
      this.emitAudit(ctx, {
        type: "recovery_attempted",
        payload: {
          errorCode: agentError.code,
          message: recoveryResult.message,
        },
      });

      // 根据恢复结果修改上下文
      if (recoveryResult.statePatch) {
        ctx = { ...ctx, state: { ...ctx.state, ...recoveryResult.statePatch } };
      }

      // 如果有修改后的请求，重试
      if (recoveryResult.modifiedRequest) {
        // continue 到主循环的下一次迭代
        lastModelRequest = recoveryResult.modifiedRequest;
        continue; // 继续主循环
      }
    }
  }

  // 恢复失败，走原有的失败流程
  // ... 现有的错误处理 ...
}
```

#### 工具执行容错

```typescript
// runtime.ts — tool_calls 分支

// 当前：工具失败直接抛出
const execResult = await this.toolExecutor.run(call, ctx);

// 改为：可选的容错模式
try {
  const execResult = await this.toolExecutor.run(call, ctx);
  // ... 正常处理 ...
} catch (toolError) {
  if (this.recovery?.canRecover(new AgentError({ code: "TOOL_ERROR", message: toolError.message }))) {
    // 容错：将错误作为工具结果返回
    const errorMessage = `工具执行失败: ${toolError.message}`;
    ctx = this.patchState(ctx, {}, (s) =>
      this.messageManager.appendToolResultMessage(s, call.name, call.id, errorMessage),
    );
    continue; // 继续下一个工具
  }
  throw toolError; // 无法恢复，重新抛出
}
```

### 审计事件扩展

```typescript
export type AuditEventType =
  | ... // 现有
  | "recovery_attempted"   // 新增
  | "recovery_succeeded"   // 新增
  | "recovery_failed";     // 新增
```

### EnterpriseAgentBase 扩展

```typescript
abstract class EnterpriseAgentBase {
  // 新增可选方法
  protected getRecoveryConfig?(): RecoveryManagerConfig;
}
```

---

## 测试策略

### 单元测试

| 测试文件 | 测试内容 |
|---------|---------|
| `test/recovery-manager.test.ts` | 策略匹配、尝试次数、重置 |
| `test/output-truncation.test.ts` | 截断检测、继续消息追加 |
| `test/context-overflow.test.ts` | 溢出检测、消息压缩 |
| `test/model-fallback.test.ts` | 降级链、索引递增、耗尽 |
| `test/tool-failure.test.ts` | 容错计数、连续失败阈值 |

### 集成测试

| 测试场景 | 验证点 |
|---------|--------|
| 模型输出截断 | 自动追加继续消息，输出合并完整 |
| 上下文溢出 | 自动压缩后重试成功 |
| 模型降级 | 主模型失败后切换降级模型 |
| 工具失败容错 | 工具失败后模型收到错误信息并继续 |
| 恢复耗尽 | 超过最大次数后正确失败 |

---

## 实现优先级

1. **P0 — 必须实现**
   - `RecoveryManager`
   - `OutputTruncationRecovery`（最常见）
   - `ContextOverflowRecovery`（配合 Context Window Management）
   - Runtime 集成（catch 块 + 重试循环）

2. **P1 — 应该实现**
   - `ToolFailureRecovery`（提升鲁棒性）
   - 审计事件扩展

3. **P2 — 可以延后**
   - `ModelFallbackRecovery`（@renx/model 已有部分支持）
   - 自定义恢复策略注册
   - 恢复策略的组合和优先级

---

## 使用示例

```typescript
class MyAgent extends EnterpriseAgentBase {
  protected getRecoveryConfig(): RecoveryManagerConfig {
    return {
      outputTruncation: { maxAttempts: 2 },
      contextOverflow: { maxAttempts: 2, compactAndRetry: true },
      modelFallback: {
        fallbackModels: [
          "openrouter:anthropic/claude-sonnet-4-20250514",
          "openrouter:openai/gpt-4o",
        ],
        maxFallbacks: 2,
      },
      toolFailure: {
        enabled: true,
        maxConsecutiveFailures: 3,
      },
    };
  }
}
```
