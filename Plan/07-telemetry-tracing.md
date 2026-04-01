# 07 - 遥测追踪 (Telemetry & Tracing)

## 问题陈述

当前 SDK 没有任何可观测性（Observability）支持：

1. **无分布式追踪** — 无法追踪一个请求在模型调用、工具执行、中间件之间的完整链路
2. **无指标导出** — 无法统计平均延迟、成功率、token 消耗等运营指标
3. **无结构化日志** — console.log 不够用于生产环境
4. **无法集成 APM** — 不支持 OpenTelemetry、Datadog、Jaeger 等主流工具
5. **性能盲区** — 不知道时间花在模型调用 vs 工具执行 vs 中间件

### 对标分析

| 能力 | Claude Code | renx-code-v3 当前 |
|------|------------|-------------------|
| OpenTelemetry 集成 | 有 | 无 |
| Span/Trace 追踪 | 有 | 无 |
| 指标导出 | 有（metrics） | 无 |
| 结构化日志 | 有 | 仅 console.log |
| 性能剖析 | 有（per-step timing） | 仅 timingMiddleware |

## 设计原则

1. **零依赖核心** — SDK 核心不依赖 OpenTelemetry SDK，通过接口抽象
2. **可选集成** — 用户不配置遥测时，零性能开销
3. **结构化数据** — 所有遥测数据都是结构化的（JSON），不是文本日志
4. **标准兼容** — 遵循 OpenTelemetry 语义约定

---

## 架构设计

### 核心概念

```
┌─────────────────────────────────────────────────────┐
│               TelemetryManager                       │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Tracer      │  │ Meter        │  │ Logger      │ │
│  │             │  │              │  │            │ │
│  │ - startSpan │  │ - counter    │  │ - info     │ │
│  │ - endSpan   │  │ - histogram  │  │ - error    │ │
│  │ - addEvent  │  │ - gauge      │  │ - debug    │ │
│  └─────────────┘  └──────────────┘  └────────────┘ │
│                                                     │
│  ┌─────────────────────────────────────────────────┐│
│  │ Exporters                                       ││
│  │ - ConsoleExporter (内置)                        ││
│  │ - OpenTelemetryExporter (适配层)                ││
│  │ - CustomExporter (用户自定义)                   ││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

### 新增文件清单

```
src/telemetry/
  index.ts                    — barrel export
  types.ts                    — 遥测类型定义
  telemetry-manager.ts        — 遥测管理器（入口）
  tracer.ts                   — 追踪器（Span 管理）
  meter.ts                    — 指标器（Metrics 管理）
  structured-logger.ts        — 结构化日志器
  span.ts                     — Span 实现
  context.ts                  — 追踪上下文传播
  exporters/
    console-exporter.ts       — 控制台导出器（内置）
    noop-exporter.ts          — 空导出器（默认）
  semantic-conventions.ts     — 语义约定（属性名、指标名）
```

---

## 详细设计

### 1. 类型定义

```typescript
// src/telemetry/types.ts

/**
 * Span 状态。
 */
export type SpanStatus = "unset" | "ok" | "error";

/**
 * Span 类型。
 */
export type SpanKind = "internal" | "client" | "server" | "producer" | "consumer";

/**
 * Span 数据（不可变快照）。
 */
export interface SpanData {
  /** Span 唯一 ID */
  spanId: string;

  /** 所属 Trace ID */
  traceId: string;

  /** 父 Span ID */
  parentSpanId?: string;

  /** Span 名称 */
  name: string;

  /** Span 类型 */
  kind: SpanKind;

  /** 开始时间（ISO 8601） */
  startTime: string;

  /** 结束时间（ISO 8601） */
  endTime?: string;

  /** 持续时间 ms */
  durationMs?: number;

  /** 状态 */
  status: SpanStatus;

  /** 属性 */
  attributes: Record<string, string | number | boolean>;

  /** 事件列表 */
  events: SpanEvent[];

  /** 关联链接 */
  links: Array<{ traceId: string; spanId: string }>;
}

/**
 * Span 事件。
 */
export interface SpanEvent {
  /** 事件名称 */
  name: string;

  /** 事件时间 */
  timestamp: string;

  /** 事件属性 */
  attributes: Record<string, string | number | boolean>;
}

/**
 * 指标类型。
 */
export interface MetricData {
  /** 指标名称 */
  name: string;

  /** 指标类型 */
  type: "counter" | "histogram" | "gauge";

  /** 指标值 */
  value: number;

  /** 属性/标签 */
  attributes: Record<string, string | number | boolean>;

  /** 时间戳 */
  timestamp: string;
}

/**
 * 日志级别。
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * 结构化日志记录。
 */
export interface LogRecord {
  /** 时间戳 */
  timestamp: string;

  /** 日志级别 */
  level: LogLevel;

  /** 消息 */
  message: string;

  /** 属性 */
  attributes: Record<string, unknown>;

  /** 关联的 traceId */
  traceId?: string;

  /** 关联的 spanId */
  spanId?: string;
}

// --- 导出器接口 ---

/**
 * 遥测导出器接口。
 * 负责将 Span、Metric、Log 数据导出到外部系统。
 */
export interface TelemetryExporter {
  /** 导出 Span */
  exportSpan(span: SpanData): void | Promise<void>;

  /** 导出指标 */
  exportMetric(metric: MetricData): void | Promise<void>;

  /** 导出日志 */
  exportLog(record: LogRecord): void | Promise<void>;

  /** 刷新缓冲区 */
  flush?(): Promise<void>;

  /** 关闭导出器 */
  shutdown?(): Promise<void>;
}

/**
 * 遥测配置。
 */
export interface TelemetryConfig {
  /** 服务名称 */
  serviceName: string;

  /** 服务版本 */
  serviceVersion?: string;

  /** 导出器列表 */
  exporters?: TelemetryExporter[];

  /** 是否启用追踪（默认 true） */
  tracingEnabled?: boolean;

  /** 是否启用指标（默认 true） */
  metricsEnabled?: boolean;

  /** 是否启用日志（默认 true） */
  loggingEnabled?: boolean;

  /** 日志最低级别（默认 info） */
  minLogLevel?: LogLevel;

  /** 追踪采样率 (0-1，默认 1） */
  samplingRate?: number;
}
```

### 2. Span — 追踪单元

```typescript
// src/telemetry/span.ts

/**
 * Span — 代表一个操作的执行过程。
 *
 * 使用方式：
 * ```ts
 * const span = tracer.startSpan("model.generate", { ... });
 * try {
 *   const result = await doSomething();
 *   span.setStatus("ok");
 *   return result;
 * } catch (err) {
 *   span.setStatus("error");
 *   span.recordException(err);
 *   throw err;
 * } finally {
 *   span.end();
 * }
 * ```
 */
export class Span {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startTime: string;

  status: SpanStatus = "unset";
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[] = [];
  links: Array<{ traceId: string; spanId: string }>;

  private endTime?: string;
  private readonly exporter: TelemetryExporter | undefined;
  private readonly onEnd: (span: SpanData) => void;

  constructor(options: {
    spanId: string;
    traceId: string;
    parentSpanId?: string;
    name: string;
    kind: SpanKind;
    attributes?: Record<string, string | number | boolean>;
    exporter?: TelemetryExporter;
    onEnd: (span: SpanData) => void;
  }) {
    this.spanId = options.spanId;
    this.traceId = options.traceId;
    this.parentSpanId = options.parentSpanId;
    this.name = options.name;
    this.kind = options.kind;
    this.startTime = new Date().toISOString();
    this.attributes = { ...options.attributes };
    this.links = [];
    this.exporter = options.exporter;
    this.onEnd = options.onEnd;
  }

  /**
   * 设置 Span 状态。
   */
  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }

  /**
   * 设置属性。
   */
  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  /**
   * 批量设置属性。
   */
  setAttributes(attrs: Record<string, string | number | boolean>): this {
    Object.assign(this.attributes, attrs);
    return this;
  }

  /**
   * 添加事件。
   */
  addEvent(name: string, attributes: Record<string, string | number | boolean> = {}): this {
    this.events.push({
      name,
      timestamp: new Date().toISOString(),
      attributes,
    });
    return this;
  }

  /**
   * 记录异常。
   */
  recordException(error: Error | unknown): this {
    this.setStatus("error");
    this.addEvent("exception", {
      "exception.type": error instanceof Error ? error.constructor.name : "Error",
      "exception.message": error instanceof Error ? error.message : String(error),
      "exception.stacktrace": error instanceof Error ? error.stack ?? "" : "",
    });
    return this;
  }

  /**
   * 结束 Span。
   */
  end(): void {
    this.endTime = new Date().toISOString();
    const data = this.toData();
    this.onEnd(data);
    this.exporter?.exportSpan(data);
  }

  /**
   * 获取 Span 的不可变快照。
   */
  toData(): SpanData {
    const startMs = new Date(this.startTime).getTime();
    const endMs = this.endTime ? new Date(this.endTime).getTime() : startMs;

    return {
      spanId: this.spanId,
      traceId: this.traceId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs: endMs - startMs,
      status: this.status,
      attributes: { ...this.attributes },
      events: [...this.events],
      links: [...this.links],
    };
  }

  /**
   * 是否已结束。
   */
  get ended(): boolean {
    return this.endTime !== undefined;
  }
}
```

### 3. Tracer — 追踪器

```typescript
// src/telemetry/tracer.ts

/**
 * 追踪器 — 创建和管理 Span。
 *
 * 每个 Agent Run 对应一个 Trace（由 traceId 标识）。
 * Trace 内的每次操作（模型调用、工具执行、中间件）都对应一个 Span。
 */
export class Tracer {
  private readonly serviceName: string;
  private readonly exporters: TelemetryExporter[];
  private readonly samplingRate: number;
  private readonly completedSpans: SpanData[] = [];

  constructor(options: {
    serviceName: string;
    exporters: TelemetryExporter[];
    samplingRate?: number;
  }) {
    this.serviceName = options.serviceName;
    this.exporters = options.exporters;
    this.samplingRate = options.samplingRate ?? 1;
  }

  /**
   * 启动一个新的 Trace。
   * @returns root Span
   */
  startTrace(name: string, attributes?: Record<string, string | number | boolean>): Span {
    const traceId = generateTraceId();
    return this.createSpan({
      traceId,
      name,
      kind: "internal",
      attributes: {
        "service.name": this.serviceName,
        ...attributes,
      },
    });
  }

  /**
   * 在现有 Span 下创建子 Span。
   */
  startSpan(
    parentSpan: Span,
    name: string,
    options?: {
      kind?: SpanKind;
      attributes?: Record<string, string | number | boolean>;
    },
  ): Span {
    return this.createSpan({
      traceId: parentSpan.traceId,
      parentSpanId: parentSpan.spanId,
      name,
      kind: options?.kind ?? "internal",
      attributes: options?.attributes,
    });
  }

  /**
   * 获取所有已完成的 Span。
   */
  getCompletedSpans(): SpanData[] {
    return [...this.completedSpans];
  }

  /**
   * 获取指定 Trace 的所有 Span（树结构）。
   */
  getTraceTree(traceId: string): SpanData[] {
    return this.completedSpans.filter((s) => s.traceId === traceId);
  }

  private createSpan(options: {
    traceId: string;
    parentSpanId?: string;
    name: string;
    kind: SpanKind;
    attributes?: Record<string, string | number | boolean>;
  }): Span {
    return new Span({
      spanId: generateSpanId(),
      traceId: options.traceId,
      parentSpanId: options.parentSpanId,
      name: options.name,
      kind: options.kind,
      attributes: options.attributes,
      onEnd: (spanData) => {
        this.completedSpans.push(spanData);
      },
    });
  }
}

// ID 生成（简化版，生产环境应使用 crypto.randomUUID 或更短的 ID）
function generateTraceId(): string {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateSpanId(): string {
  return `span_${Math.random().toString(36).slice(2, 10)}`;
}
```

### 4. Meter — 指标器

```typescript
// src/telemetry/meter.ts

/**
 * 指标器 — 记录和导出运行指标。
 *
 * 支持三种指标类型：
 * - Counter（计数器）：单调递增，如请求总数
 * - Histogram（直方图）：记录分布，如延迟
 * - Gauge（仪表盘）：当前值，如活跃请求数
 */
export class Meter {
  private readonly exporters: TelemetryExporter[];
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();
  private readonly gauges = new Map<string, number>();
  private readonly commonAttributes: Record<string, string | number | boolean>;

  constructor(options: {
    exporters: TelemetryExporter[];
    commonAttributes?: Record<string, string | number | boolean>;
  }) {
    this.exporters = options.exporters;
    this.commonAttributes = options.commonAttributes ?? {};
  }

  /**
   * 递增计数器。
   */
  incrementCounter(
    name: string,
    value: number = 1,
    attributes: Record<string, string | number | boolean> = {},
  ): void {
    const key = this.metricKey(name, attributes);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);

    this.exportMetric({
      name,
      type: "counter",
      value: this.counters.get(key)!,
      attributes: { ...this.commonAttributes, ...attributes },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 记录直方图值（通常用于延迟）。
   */
  recordHistogram(
    name: string,
    value: number,
    attributes: Record<string, string | number | boolean> = {},
  ): void {
    const key = this.metricKey(name, attributes);
    const values = this.histograms.get(key) ?? [];
    values.push(value);
    this.histograms.set(key, values);

    this.exportMetric({
      name,
      type: "histogram",
      value,
      attributes: { ...this.commonAttributes, ...attributes },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 设置仪表盘值。
   */
  setGauge(
    name: string,
    value: number,
    attributes: Record<string, string | number | boolean> = {},
  ): void {
    const key = this.metricKey(name, attributes);
    this.gauges.set(key, value);

    this.exportMetric({
      name,
      type: "gauge",
      value,
      attributes: { ...this.commonAttributes, ...attributes },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 记录延迟（直方图的便捷方法）。
   * 传入开始时间，自动计算差值。
   */
  recordLatency(
    name: string,
    startTime: number,
    attributes: Record<string, string | number | boolean> = {},
  ): void {
    this.recordHistogram(name, Date.now() - startTime, attributes);
  }

  /**
   * 获取计数器值。
   */
  getCounter(name: string, attributes: Record<string, string | number | boolean> = {}): number {
    return this.counters.get(this.metricKey(name, attributes)) ?? 0;
  }

  /**
   * 获取直方图统计。
   */
  getHistogramStats(
    name: string,
    attributes: Record<string, string | number | boolean> = {},
  ): { min: number; max: number; avg: number; count: number; p50: number; p95: number; p99: number } | null {
    const values = this.histograms.get(this.metricKey(name, attributes));
    if (!values || values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    return {
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      count: values.length,
      p50: sorted[Math.floor(sorted.length * 0.5)]!,
      p95: sorted[Math.floor(sorted.length * 0.95)]!,
      p99: sorted[Math.floor(sorted.length * 0.99)]!,
    };
  }

  private metricKey(name: string, attrs: Record<string, string | number | boolean>): string {
    const attrStr = Object.entries(attrs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return `${name}|${attrStr}`;
  }

  private exportMetric(metric: MetricData): void {
    for (const exporter of this.exporters) {
      try {
        exporter.exportMetric(metric);
      } catch {
        // 导出器错误不影响主流程
      }
    }
  }
}
```

### 5. StructuredLogger — 结构化日志器

```typescript
// src/telemetry/structured-logger.ts

/**
 * 结构化日志器。
 *
 * 与 console.log 的区别：
 * - 输出 JSON 格式，易于机器解析
 * - 支持日志级别过滤
 * - 关联 traceId / spanId
 * - 支持多个输出目标
 */
export class StructuredLogger {
  private readonly exporters: TelemetryExporter[];
  private readonly minLevel: LogLevel;
  private readonly commonAttributes: Record<string, unknown>;

  private static readonly LEVEL_ORDER: Record<LogLevel, number> = {
    trace: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
    fatal: 5,
  };

  constructor(options: {
    exporters: TelemetryExporter[];
    minLevel?: LogLevel;
    commonAttributes?: Record<string, unknown>;
  }) {
    this.exporters = options.exporters;
    this.minLevel = options.minLevel ?? "info";
    this.commonAttributes = options.commonAttributes ?? {};
  }

  trace(message: string, attributes: Record<string, unknown> = {}): void {
    this.log("trace", message, attributes);
  }

  debug(message: string, attributes: Record<string, unknown> = {}): void {
    this.log("debug", message, attributes);
  }

  info(message: string, attributes: Record<string, unknown> = {}): void {
    this.log("info", message, attributes);
  }

  warn(message: string, attributes: Record<string, unknown> = {}): void {
    this.log("warn", message, attributes);
  }

  error(message: string, attributes: Record<string, unknown> = {}): void {
    this.log("error", message, attributes);
  }

  fatal(message: string, attributes: Record<string, unknown> = {}): void {
    this.log("fatal", message, attributes);
  }

  private log(level: LogLevel, message: string, attributes: Record<string, unknown>): void {
    if (StructuredLogger.LEVEL_ORDER[level] < StructuredLogger.LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      attributes: { ...this.commonAttributes, ...attributes },
    };

    for (const exporter of this.exporters) {
      try {
        exporter.exportLog(record);
      } catch {
        // 导出器错误不影响主流程
      }
    }
  }
}
```

### 6. TelemetryManager — 遥测管理器

```typescript
// src/telemetry/telemetry-manager.ts

/**
 * 遥测管理器 — SDK 可观测性的入口。
 *
 * 统一管理 Tracer、Meter、StructuredLogger。
 * 通过 TelemetryExporter 接口与外部系统集成。
 */
export class TelemetryManager {
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly logger: StructuredLogger;

  private readonly exporters: TelemetryExporter[];
  private readonly config: TelemetryConfig;

  constructor(config: TelemetryConfig) {
    this.config = config;
    this.exporters = config.exporters ?? [];

    const commonAttrs: Record<string, string | number | boolean> = {
      "service.name": config.serviceName,
      "service.version": config.serviceVersion ?? "unknown",
    };

    this.tracer = new Tracer({
      serviceName: config.serviceName,
      exporters: this.exporters,
      samplingRate: config.samplingRate,
    });

    this.meter = new Meter({
      exporters: this.exporters,
      commonAttributes: commonAttrs,
    });

    this.logger = new StructuredLogger({
      exporters: this.exporters,
      minLevel: config.minLogLevel,
      commonAttributes: commonAttrs,
    });
  }

  /**
   * 刷新所有导出器。
   */
  async flush(): Promise<void> {
    await Promise.all(this.exporters.map((e) => e.flush?.()));
  }

  /**
   * 关闭遥测管理器。
   */
  async shutdown(): Promise<void> {
    await this.flush();
    await Promise.all(this.exporters.map((e) => e.shutdown?.()));
  }
}
```

### 7. ConsoleExporter — 内置控制台导出器

```typescript
// src/telemetry/exporters/console-exporter.ts

/**
 * 控制台导出器。
 *
 * 将遥测数据输出到控制台（美化格式）。
 * 用于开发和调试。
 */
export class ConsoleExporter implements TelemetryExporter {
  exportSpan(span: SpanData): void {
    const indent = span.parentSpanId ? "  " : "";
    const statusIcon = span.status === "ok" ? "✓" : span.status === "error" ? "✗" : "·";
    console.log(
      `${indent}[Trace] ${statusIcon} ${span.name} (${span.durationMs ?? "?"}ms)` +
      (span.parentSpanId ? ` parent=${span.parentSpanId.slice(0, 8)}` : ""),
    );

    for (const event of span.events) {
      console.log(`${indent}  → ${event.name} ${JSON.stringify(event.attributes)}`);
    }
  }

  exportMetric(metric: MetricData): void {
    const icon = metric.type === "counter" ? "▲" : metric.type === "histogram" ? "📊" : "●";
    console.log(`[Metric] ${icon} ${metric.name} = ${metric.value} ${JSON.stringify(metric.attributes)}`);
  }

  exportLog(record: LogRecord): void {
    const icon: Record<LogLevel, string> = {
      trace: "🔍",
      debug: "🐛",
      info: "ℹ️",
      warn: "⚠️",
      error: "❌",
      fatal: "💀",
    };
    console.log(`[Log:${record.level}] ${icon[record.level]} ${record.message}`, record.attributes);
  }
}
```

### 8. NoopExporter — 空导出器

```typescript
// src/telemetry/exporters/noop-exporter.ts

/**
 * 空导出器。
 * 当遥测未配置时使用，零开销。
 */
export class NoopExporter implements TelemetryExporter {
  exportSpan(): void {}
  exportMetric(): void {}
  exportLog(): void {}
}
```

### 9. 语义约定

```typescript
// src/telemetry/semantic-conventions.ts

/**
 * 语义约定 — 标准化的属性名和指标名。
 * 遵循 OpenTelemetry 语义约定。
 */
export const SemConventions = {
  // --- 属性名 ---

  /** Agent 名称 */
  AGENT_NAME: "agent.name",
  /** Run ID */
  AGENT_RUN_ID: "agent.run_id",
  /** 步骤编号 */
  AGENT_STEP: "agent.step",
  /** 模型名称 */
  MODEL_NAME: "model.name",
  /** 模型提供商 */
  MODEL_PROVIDER: "model.provider",
  /** 工具名称 */
  TOOL_NAME: "tool.name",
  /** 工具调用 ID */
  TOOL_CALL_ID: "tool.call_id",
  /** 中间件名称 */
  MIDDLEWARE_NAME: "middleware.name",
  /** 策略名称 */
  POLICY_NAME: "policy.name",
  /** 错误码 */
  ERROR_CODE: "error.code",

  // --- Span 名称 ---

  /** Agent 运行 */
  SPAN_AGENT_RUN: "agent.run",
  /** 模型调用 */
  SPAN_MODEL_CALL: "model.call",
  /** 工具执行 */
  SPAN_TOOL_EXEC: "tool.exec",
  /** 中间件执行 */
  SPAN_MIDDLEWARE: "middleware.exec",
  /** 上下文压缩 */
  SPAN_CONTEXT_COMPACT: "context.compact",
  /** 恢复 */
  SPAN_RECOVERY: "recovery.attempt",

  // --- 指标名 ---

  /** Agent 运行总数 */
  METRIC_RUN_TOTAL: "agent.run.total",
  /** Agent 运行延迟 */
  METRIC_RUN_DURATION: "agent.run.duration",
  /** 模型调用延迟 */
  METRIC_MODEL_LATENCY: "model.latency",
  /** 工具执行延迟 */
  METRIC_TOOL_LATENCY: "tool.latency",
  /** 工具调用总数 */
  METRIC_TOOL_CALLS: "tool.calls.total",
  /** Token 使用量 */
  METRIC_TOKEN_USAGE: "model.tokens",
  /** 步骤数 */
  METRIC_STEP_COUNT: "agent.steps",
} as const;
```

---

## 集成到 Runtime

### 通过中间件集成（最小侵入）

创建一个遥测中间件，自动为所有操作创建 Span：

```typescript
// 内部中间件：自动注入遥测
class TelemetryMiddleware implements AgentMiddleware {
  readonly name = "telemetry";

  constructor(private readonly telemetry: TelemetryManager) {}

  beforeRun(ctx: AgentRunContext): void {
    // 创建根 Span
    const rootSpan = this.telemetry.tracer.startTrace(SemConventions.SPAN_AGENT_RUN, {
      [SemConventions.AGENT_NAME]: ctx.state.runId,
      [SemConventions.AGENT_RUN_ID]: ctx.state.runId,
    });
    ctx.state.scratchpad["_telemetryRootSpan"] = rootSpan;

    this.telemetry.meter.incrementCounter(SemConventions.METRIC_RUN_TOTAL);
    this.telemetry.logger.info("Agent run started", {
      runId: ctx.state.runId,
    });
  }

  beforeModel(ctx: AgentRunContext, req: ModelRequest): ModelRequest {
    const rootSpan = ctx.state.scratchpad["_telemetryRootSpan"] as Span;
    const modelSpan = this.telemetry.tracer.startSpan(rootSpan, SemConventions.SPAN_MODEL_CALL, {
      kind: "client",
      attributes: {
        [SemConventions.MODEL_NAME]: req.model,
        [SemConventions.AGENT_STEP]: ctx.state.stepCount,
      },
    });
    ctx.state.scratchpad["_telemetryModelSpan"] = modelSpan;
    ctx.state.scratchpad["_telemetryModelStart"] = Date.now();

    return req;
  }

  afterModel(ctx: AgentRunContext, resp: ModelResponse): ModelResponse {
    const modelSpan = ctx.state.scratchpad["_telemetryModelSpan"] as Span;
    if (modelSpan) {
      modelSpan
        .setAttribute("response.type", resp.type)
        .setStatus("ok")
        .end();
    }

    this.telemetry.meter.recordLatency(
      SemConventions.METRIC_MODEL_LATENCY,
      ctx.state.scratchpad["_telemetryModelStart"] as number,
    );

    return resp;
  }

  beforeTool(ctx: AgentRunContext, call: ToolCall): MiddlewareDecision {
    const rootSpan = ctx.state.scratchpad["_telemetryRootSpan"] as Span;
    const toolSpan = this.telemetry.tracer.startSpan(rootSpan, SemConventions.SPAN_TOOL_EXEC, {
      kind: "client",
      attributes: {
        [SemConventions.TOOL_NAME]: call.name,
        [SemConventions.TOOL_CALL_ID]: call.id,
      },
    });
    ctx.state.scratchpad[`_telemetryToolSpan_${call.id}`] = toolSpan;
    ctx.state.scratchpad[`_telemetryToolStart_${call.id}`] = Date.now();

    return {};
  }

  afterTool(ctx: AgentRunContext, result: ToolExecutionResult): MiddlewareDecision {
    const toolSpan = ctx.state.scratchpad[`_telemetryToolSpan_${result.call.id}`] as Span;
    if (toolSpan) {
      toolSpan.setStatus("ok").end();
    }

    this.telemetry.meter.recordLatency(
      SemConventions.METRIC_TOOL_LATENCY,
      ctx.state.scratchpad[`_telemetryToolStart_${result.call.id}`] as number,
      { [SemConventions.TOOL_NAME]: result.tool.name },
    );

    this.telemetry.meter.incrementCounter(SemConventions.METRIC_TOOL_CALLS, 1, {
      [SemConventions.TOOL_NAME]: result.tool.name,
    });

    return {};
  }

  onError(ctx: AgentRunContext, error: AgentError): void {
    const rootSpan = ctx.state.scratchpad["_telemetryRootSpan"] as Span;
    if (rootSpan) {
      rootSpan.recordException(error);
    }

    this.telemetry.logger.error("Agent error", {
      runId: ctx.state.runId,
      errorCode: error.code,
      errorMessage: error.message,
    });
  }

  afterRun(ctx: AgentRunContext, result: AgentResult): void {
    const rootSpan = ctx.state.scratchpad["_telemetryRootSpan"] as Span;
    if (rootSpan) {
      rootSpan
        .setAttribute("status", result.status)
        .setStatus(result.status === "completed" ? "ok" : "error")
        .end();
    }

    this.telemetry.meter.recordLatency(
      SemConventions.METRIC_RUN_DURATION,
      new Date(rootSpan?.toData().startTime ?? Date.now()).getTime(),
    );

    this.telemetry.meter.setGauge(
      SemConventions.METRIC_STEP_COUNT,
      result.state.stepCount,
    );

    this.telemetry.logger.info("Agent run completed", {
      runId: result.runId,
      status: result.status,
      steps: result.state.stepCount,
    });

    // 刷新导出器
    this.telemetry.flush();
  }
}
```

### RuntimeConfig 扩展

```typescript
export interface RuntimeConfig {
  // ... 现有字段 ...
  /** 遥测管理器（可选） */
  telemetry?: TelemetryManager;
}
```

当 `telemetry` 存在时，自动注册 `TelemetryMiddleware`：

```typescript
// runtime.ts constructor
if (config.telemetry) {
  this.pipeline.add(new TelemetryMiddleware(config.telemetry));
}
```

### EnterpriseAgentBase 扩展

```typescript
abstract class EnterpriseAgentBase {
  protected getTelemetryConfig?(): TelemetryConfig;
}
```

---

## OpenTelemetry 适配器（独立包，可选）

```typescript
// 可在 @renx/telemetry-otel 包中提供（不在核心 SDK 中）

import { trace, metrics, logs } from "@opentelemetry/api";

/**
 * OpenTelemetry 导出器适配器。
 * 将 renx 的遥测数据桥接到 OpenTelemetry SDK。
 */
export class OpenTelemetryExporter implements TelemetryExporter {
  private readonly tracer = trace.getTracer("renx-agent");
  private readonly meter = metrics.getMeter("renx-agent");
  private readonly logger = logs.getLogger("renx-agent");

  exportSpan(span: SpanData): void {
    const otelSpan = this.tracer.startSpan(span.name, {
      kind: span.kind,
      startTime: new Date(span.startTime),
      attributes: span.attributes,
    });

    for (const event of span.events) {
      otelSpan.addEvent(event.name, event.attributes, new Date(event.timestamp));
    }

    otelSpan.setStatus({ code: span.status === "ok" ? 1 : span.status === "error" ? 2 : 0 });
    otelSpan.end(new Date(span.endTime ?? span.startTime));
  }

  exportMetric(metric: MetricData): void {
    // 根据 metric.type 使用对应的 OTel API
    // counter → otelCounter.add(value, attrs)
    // histogram → otelHistogram.record(value, attrs)
    // gauge → otelGauge.record(value, attrs)
  }

  exportLog(record: LogRecord): void {
    this.logger.emit({
      severityNumber: this.levelToSeverity(record.level),
      body: record.message,
      attributes: record.attributes as Record<string, string>,
    });
  }

  private levelToSeverity(level: LogLevel): number {
    const map: Record<LogLevel, number> = {
      trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21,
    };
    return map[level];
  }
}
```

---

## 测试策略

### 单元测试

| 测试文件 | 测试内容 |
|---------|---------|
| `test/span.test.ts` | 创建、属性、事件、结束、快照 |
| `test/tracer.test.ts` | trace/span 创建、父子关系、ID 唯一性 |
| `test/meter.test.ts` | counter/histogram/gauge、统计计算 |
| `test/structured-logger.test.ts` | 级别过滤、属性合并 |
| `test/telemetry-manager.test.ts` | 组件协调、flush/shutdown |
| `test/console-exporter.test.ts` | 输出格式 |

### 集成测试

| 测试场景 | 验证点 |
|---------|--------|
| 完整 run 的追踪 | Span 树结构正确（root → model/tool → children） |
| 指标记录 | 延迟、计数器、步骤数正确 |
| 错误追踪 | 异常记录在 Span 中 |
| 导出器调用 | Span/Metric/Log 都被导出 |

---

## 实现优先级

1. **P0 — 必须实现**
   - `Span`
   - `Tracer`
   - `TelemetryManager`
   - `TelemetryMiddleware`
   - `ConsoleExporter`
   - Runtime 集成

2. **P1 — 应该实现**
   - `Meter`（counter、histogram、latency）
   - `StructuredLogger`
   - 语义约定

3. **P2 — 可以延后**
   - `NoopExporter`
   - OpenTelemetry 适配器
   - 采样率控制
   - 追踪上下文传播（跨进程）

---

## 使用示例

```typescript
// 创建遥测管理器
const telemetry = new TelemetryManager({
  serviceName: "my-agent-service",
  serviceVersion: "1.0.0",
  exporters: [new ConsoleExporter()],
  minLogLevel: "info",
});

// 集成到 Agent
class MyAgent extends EnterpriseAgentBase {
  protected getTelemetryConfig(): TelemetryConfig {
    return {
      serviceName: "life-assistant",
      exporters: [new ConsoleExporter()],
    };
  }
}

// 查看追踪树
const spans = telemetry.tracer.getTraceTree(traceId);
for (const span of spans) {
  console.log(`${span.name} - ${span.durationMs}ms [${span.status}]`);
}
```
