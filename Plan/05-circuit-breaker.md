# 05 - 熔断器 (Circuit Breaker)

## 问题陈述

当前 SDK 没有熔断机制。在以下场景中会导致资源浪费和雪崩效应：

1. **工具连续失败** — 网络故障导致外部 API 工具反复超时，每次都要等超时才知道失败
2. **模型服务降级** — 模型提供商部分不可用时，每次请求都在等待超时
3. **费用失控** — 工具调用模型失败后不断重试，每次都消耗 token
4. **用户体验差** — 用户需要等待整个超时周期才能得到失败反馈

### 对标分析

| 能力 | Claude Code | renx-code-v3 当前 |
|------|------------|-------------------|
| 工具级熔断 | 有（连续失败后跳过） | 无 |
| 模型级熔断 | 有（检测过载后等待） | 无（仅 @renx/model 有重试） |
| 半开状态检测 | 有（定期探测恢复） | 无 |
| 熔断指标暴露 | 有 | 无 |

## 设计参考

经典熔断器模式（Martin Fowler / Netflix Hystrix）：

```
         成功              失败达到阈值
  CLOSED ─────→ CLOSED ────────────→ OPEN
    ↑                                  │
    │                                  │ 冷却时间后
    │ 探测成功                          ↓
    │                              HALF_OPEN
    └────────────────────────────── ───┘
              探测失败 → OPEN
```

三种状态：
- **CLOSED**（关闭）— 正常工作，统计失败率
- **OPEN**（打开）— 快速失败，不执行调用
- **HALF_OPEN**（半开）— 允许一次探测调用，决定是否恢复

---

## 架构设计

### 新增文件清单

```
src/resilience/
  index.ts                    — barrel export
  circuit-breaker.ts          — 通用熔断器实现
  tool-circuit-breaker.ts     — 工具级熔断器
  model-circuit-breaker.ts    — 模型级熔断器
  types.ts                    — 熔断器类型定义
```

---

## 详细设计

### 1. 类型定义

```typescript
// src/resilience/types.ts

/**
 * 熔断器状态。
 */
export type CircuitState = "closed" | "open" | "half_open";

/**
 * 熔断器配置。
 */
export interface CircuitBreakerConfig {
  /** 失败计数阈值（超过此数打开熔断器，默认 5） */
  failureThreshold: number;

  /** 成功计数阈值（半开状态下连续成功此数关闭熔断器，默认 2） */
  successThreshold: number;

  /** 熔断器打开后的冷却时间 ms（默认 30000） */
  resetTimeoutMs: number;

  /** 时间窗口 ms（只统计此窗口内的失败，默认 60000） */
  timeWindowMs: number;

  /** 半开状态下允许的最大探测请求数（默认 1） */
  halfOpenMaxRequests: number;

  /** 监听器 */
  onStateChange?: (from: CircuitState, to: CircuitState, metrics: CircuitMetrics) => void;
}

/**
 * 熔断器指标。
 */
export interface CircuitMetrics {
  /** 当前状态 */
  state: CircuitState;

  /** 总调用次数 */
  totalCalls: number;

  /** 失败次数 */
  failureCount: number;

  /** 成功次数 */
  successCount: number;

  /** 失败率 (0-1) */
  failureRate: number;

  /** 最近一次失败时间 */
  lastFailureTime?: string;

  /** 最近一次成功时间 */
  lastSuccessTime?: string;

  /** 熔断器打开时间 */
  openedAt?: string;
}

/**
 * 熔断器决策结果。
 */
export interface CircuitDecision {
  /** 是否允许通过 */
  allowed: boolean;

  /** 当前状态 */
  state: CircuitState;

  /** 拒绝原因（当 allowed=false 时） */
  reason?: string;
}
```

### 2. 通用熔断器

```typescript
// src/resilience/circuit-breaker.ts

/**
 * 通用熔断器实现。
 *
 * 基于「滑动时间窗口」统计失败率：
 * - 只统计最近 timeWindowMs 时间内的调用
 * - 超过 failureThreshold 次失败 → 打开熔断器
 * - 熔断器打开后等待 resetTimeoutMs → 进入半开状态
 * - 半开状态下允许有限次探测 → 成功则关闭，失败则重新打开
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private readonly config: CircuitBreakerConfig;

  // 滑动窗口内的调用记录
  private readonly calls: Array<{
    success: boolean;
    timestamp: number;
  }> = [];

  // 半开状态下的探测计数
  private halfOpenCalls = 0;
  private halfOpenSuccesses = 0;

  // 熔断器打开时间
  private openedAt: number | null = null;

  constructor(config: Partial<CircuitBreakerConfig> & { name: string }) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      successThreshold: config.successThreshold ?? 2,
      resetTimeoutMs: config.resetTimeoutMs ?? 30_000,
      timeWindowMs: config.timeWindowMs ?? 60_000,
      halfOpenMaxRequests: config.halfOpenMaxRequests ?? 1,
      onStateChange: config.onStateChange,
    };
    this.name = config.name;
  }

  readonly name: string;

  /**
   * 检查是否允许调用通过。
   *
   * 在 OPEN 状态下返回 false（快速失败）。
   * 在 HALF_OPEN 状态下允许有限次探测。
   */
  allow(): CircuitDecision {
    this.pruneWindow();

    switch (this.state) {
      case "closed":
        return { allowed: true, state: "closed" };

      case "open": {
        const elapsed = Date.now() - (this.openedAt ?? Date.now());
        if (elapsed >= this.config.resetTimeoutMs) {
          // 冷却时间已过，进入半开状态
          this.transitionTo("half_open");
          this.halfOpenCalls = 0;
          this.halfOpenSuccesses = 0;
          return { allowed: true, state: "half_open" };
        }

        return {
          allowed: false,
          state: "open",
          reason: `${this.name} 熔断器已打开，冷却剩余 ${Math.ceil((this.config.resetTimeoutMs - elapsed) / 1000)}s`,
        };
      }

      case "half_open": {
        if (this.halfOpenCalls < this.config.halfOpenMaxRequests) {
          return { allowed: true, state: "half_open" };
        }
        return {
          allowed: false,
          state: "half_open",
          reason: `${this.name} 熔断器半开状态，等待探测结果`,
        };
      }
    }
  }

  /**
   * 记录成功调用。
   */
  recordSuccess(): void {
    this.calls.push({ success: true, timestamp: Date.now() });

    if (this.state === "half_open") {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.successThreshold) {
        this.transitionTo("closed");
      }
    }
  }

  /**
   * 记录失败调用。
   */
  recordFailure(): void {
    this.calls.push({ success: false, timestamp: Date.now() });

    if (this.state === "half_open") {
      // 半开状态下失败，立即重新打开
      this.transitionTo("open");
      return;
    }

    // 检查是否达到阈值
    const failures = this.countRecentFailures();
    if (failures >= this.config.failureThreshold) {
      this.transitionTo("open");
    }
  }

  /**
   * 获取当前指标。
   */
  getMetrics(): CircuitMetrics {
    this.pruneWindow();
    const failures = this.countRecentFailures();
    const successes = this.calls.filter((c) => c.success).length;
    const total = this.calls.length;

    return {
      state: this.state,
      totalCalls: total,
      failureCount: failures,
      successCount: successes,
      failureRate: total > 0 ? failures / total : 0,
      lastFailureTime: this.findLast(false)?.timestamp
        ? new Date(this.findLast(false)!.timestamp).toISOString()
        : undefined,
      lastSuccessTime: this.findLast(true)?.timestamp
        ? new Date(this.findLast(true)!.timestamp).toISOString()
        : undefined,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : undefined,
    };
  }

  /**
   * 手动重置熔断器为关闭状态。
   */
  reset(): void {
    this.transitionTo("closed");
    this.calls.length = 0;
  }

  // --- Private ---

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;

    if (newState === "open") {
      this.openedAt = Date.now();
    } else if (newState === "closed") {
      this.openedAt = null;
    }

    this.config.onStateChange?.(oldState, newState, this.getMetrics());
  }

  private pruneWindow(): void {
    const cutoff = Date.now() - this.config.timeWindowMs;
    while (this.calls.length > 0 && this.calls[0]!.timestamp < cutoff) {
      this.calls.shift();
    }
  }

  private countRecentFailures(): number {
    return this.calls.filter((c) => !c.success).length;
  }

  private findLast(success: boolean) {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (this.calls[i]!.success === success) return this.calls[i];
    }
    return null;
  }
}
```

### 3. 工具级熔断器

```typescript
// src/resilience/tool-circuit-breaker.ts

/**
 * 工具级熔断器。
 *
 * 为每个工具维护独立的熔断器实例。
 * 当某个工具的熔断器打开时，直接返回快速失败结果，
 * 不执行实际工具调用。
 *
 * 集成方式：作为 AgentMiddleware 使用。
 */
export class ToolCircuitBreakerMiddleware implements AgentMiddleware {
  readonly name = "tool-circuit-breaker";
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly configFactory: (toolName: string) => Partial<CircuitBreakerConfig>;

  constructor(options?: {
    /** 每个工具的熔断器配置（默认统一配置） */
    defaultConfig?: Partial<CircuitBreakerConfig>;
    /** 自定义配置工厂（按工具名定制） */
    configFactory?: (toolName: string) => Partial<CircuitBreakerConfig>;
  }) {
    this.configFactory = options?.configFactory ??
      (() => options?.defaultConfig ?? {});
  }

  /**
   * beforeTool 钩子：检查工具熔断器状态。
   */
  beforeTool(
    _ctx: AgentRunContext,
    call: ToolCall,
  ): MiddlewareDecision | Promise<MiddlewareDecision> {
    const breaker = this.getOrCreateBreaker(call.name);
    const decision = breaker.allow();

    if (!decision.allowed) {
      // 熔断器打开，快速失败
      return {
        stopCurrentStep: true,
        statePatch: {
          mergeMemory: {
            [`circuit_breaker_skip_${call.name}`]: {
              reason: decision.reason,
              timestamp: new Date().toISOString(),
            },
          },
        },
      };
    }

    return {}; // 允许通过
  }

  /**
   * afterTool 钩子：记录工具执行结果。
   */
  afterTool(
    _ctx: AgentRunContext,
    result: ToolExecutionResult,
  ): MiddlewareDecision | Promise<MiddlewareDecision> {
    const breaker = this.getOrCreateBreaker(result.tool.name);

    // 判断工具是否"失败"
    const failed = result.output.content.startsWith("❌") ||
                   result.output.content.includes("失败") ||
                   result.output.content.includes("error");

    if (failed) {
      breaker.recordFailure();
    } else {
      breaker.recordSuccess();
    }

    return {};
  }

  /**
   * 获取指定工具的熔断器指标。
   */
  getToolMetrics(toolName: string): CircuitMetrics | undefined {
    return this.breakers.get(toolName)?.getMetrics();
  }

  /**
   * 获取所有工具的熔断器指标。
   */
  getAllMetrics(): Record<string, CircuitMetrics> {
    const result: Record<string, CircuitMetrics> = {};
    for (const [name, breaker] of this.breakers) {
      result[name] = breaker.getMetrics();
    }
    return result;
  }

  /**
   * 手动重置指定工具的熔断器。
   */
  resetTool(toolName: string): void {
    this.breakers.get(toolName)?.reset();
  }

  private getOrCreateBreaker(toolName: string): CircuitBreaker {
    let breaker = this.breakers.get(toolName);
    if (!breaker) {
      const config = this.configFactory(toolName);
      breaker = new CircuitBreaker({ ...config, name: `tool:${toolName}` });
      this.breakers.set(toolName, breaker);
    }
    return breaker;
  }
}
```

### 4. 模型级熔断器

```typescript
// src/resilience/model-circuit-breaker.ts

/**
 * 模型级熔断器。
 *
 * 当模型提供商持续返回错误（500、429、超时）时，
 * 熔断器打开，后续请求快速失败而不是等待超时。
 *
 * 集成方式：作为 beforeModel/afterModel 中间件使用。
 */
export class ModelCircuitBreakerMiddleware implements AgentMiddleware {
  readonly name = "model-circuit-breaker";
  private readonly breaker: CircuitBreaker;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.breaker = new CircuitBreaker({
      ...config,
      name: "model",
      failureThreshold: config?.failureThreshold ?? 3,
      resetTimeoutMs: config?.resetTimeoutMs ?? 60_000,
    });
  }

  /**
   * beforeModel：检查模型熔断器状态。
   */
  beforeModel(_ctx: AgentRunContext, req: ModelRequest): ModelRequest {
    const decision = this.breaker.allow();

    if (!decision.allowed) {
      throw new AgentError({
        code: "MODEL_ERROR",
        message: decision.reason ?? "模型熔断器已打开",
        retryable: true,
      });
    }

    return req;
  }

  /**
   * afterModel：记录模型调用结果。
   */
  afterModel(_ctx: AgentRunContext, resp: ModelResponse): ModelResponse {
    // 模型成功返回 = 成功
    this.breaker.recordSuccess();
    return resp;
  }

  /**
   * onError：记录模型调用失败。
   */
  onError(_ctx: AgentRunContext, error: AgentError): void {
    // 只有特定错误类型才记录为失败
    const modelErrors = [
      "MODEL_ERROR",
      "SERVER_ERROR",
      "TIMEOUT",
      "RATE_LIMIT",
      "MODEL_OVERLOADED",
    ];

    if (modelErrors.includes(error.code)) {
      this.breaker.recordFailure();
    }
  }

  getMetrics(): CircuitMetrics {
    return this.breaker.getMetrics();
  }

  reset(): void {
    this.breaker.reset();
  }
}
```

---

## 集成到 Runtime

### 作为中间件使用（无需修改 Runtime）

熔断器通过中间件机制集成，**不需要修改 runtime.ts**：

```typescript
// 用户代码
const toolBreaker = new ToolCircuitBreakerMiddleware({
  defaultConfig: {
    failureThreshold: 3,
    resetTimeoutMs: 30_000,
  },
});

const modelBreaker = new ModelCircuitBreakerMiddleware({
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
});

class MyAgent extends EnterpriseAgentBase {
  protected getMiddlewares() {
    return [toolBreaker, modelBreaker];
  }
}
```

### 可选：暴露熔断器指标

通过 AgentRunContext.metadata 暴露熔断器状态：

```typescript
// afterRun 钩子中记录指标
const metrics = toolBreaker.getAllMetrics();
// 存入审计日志或 metrics 系统
```

### 审计事件扩展

```typescript
export type AuditEventType =
  | ... // 现有
  | "circuit_opened"       // 新增
  | "circuit_half_open"    // 新增
  | "circuit_closed";      // 新增
```

---

## 测试策略

### 单元测试

| 测试文件 | 测试内容 |
|---------|---------|
| `test/circuit-breaker.test.ts` | 状态转换、阈值触发、冷却恢复、半开探测、滑动窗口 |
| `test/tool-circuit-breaker.test.ts` | 中间件集成、快速失败、自动恢复 |
| `test/model-circuit-breaker.test.ts` | 模型错误分类、熔断触发 |

### 集成测试

| 测试场景 | 验证点 |
|---------|--------|
| 工具连续失败 3 次 | 第 4 次快速失败，不执行工具 |
| 熔断器冷却后恢复 | 半开状态允许一次探测 |
| 模型超时触发熔断 | 后续请求快速失败 |
| 多工具独立熔断 | 一个工具熔断不影响其他工具 |

---

## 实现优先级

1. **P0 — 必须实现**
   - `CircuitBreaker`（核心实现）
   - `ToolCircuitBreakerMiddleware`
   - `ModelCircuitBreakerMiddleware`

2. **P1 — 应该实现**
   - 自定义配置工厂
   - 指标暴露接口

3. **P2 — 可以延后**
   - 审计事件集成
   - 分布式熔断（多实例共享状态）
   - 熔断器可视化仪表板

---

## 使用示例

```typescript
// 工具级熔断
const toolBreaker = new ToolCircuitBreakerMiddleware({
  configFactory: (toolName) => {
    // 外部 API 工具更严格的熔断
    if (["get_weather", "get_stock_price"].includes(toolName)) {
      return {
        failureThreshold: 3,
        resetTimeoutMs: 30_000,
      };
    }
    // 本地工具不熔断
    return { failureThreshold: 100 };
  },
});

// 模型级熔断
const modelBreaker = new ModelCircuitBreakerMiddleware({
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  onStateChange: (from, to, metrics) => {
    console.log(`模型熔断器: ${from} → ${to}`, metrics);
  },
});
```
