# 06 - Runtime 接入、模型契约与测试计划

## 1. 文档目的

前几份文档定义了“应该有什么能力”，本文档定义“这些能力如何真正接入 `renx-code-v3` 的代码结构里”，并给出必须的模型层扩展、运行时改造点、测试清单和最终验收标准。

## 2. Agent 层接入总览

需要改造的核心文件如下：

- `packages/agent/src/runtime.ts`
- `packages/agent/src/base.ts`
- `packages/agent/src/types.ts`
- `packages/agent/src/message/manager.ts`
- `packages/agent/src/message/types.ts`

### 2.1 runtime.ts

`runtime.ts` 必须成为上下文编排的核心入口。`run()` 和 `stream()` 需要统一接入以下流程：

```text
1. 构建基础消息视图
2. 过滤工具与生成 tool definitions
3. 投影 API view
4. 执行 Stage 0（tool result budget 前置门禁）
5. 测量 token 与阈值状态
6. 若进入 auto compact 区，按五层压缩编排执行
7. 压缩后重新投影 API view
8. 若进入 blocking 区，阻断本轮调用
9. 发起模型请求
10. 若 provider 返回 PTL / media / output budget 错误，执行 recovery
11. 成功后记录 usage、response metadata、iteration stats
```

### 2.2 base.ts

`base.ts` 负责依赖装配，应扩展出：

- context window config 入口
- context orchestrator 工厂
- usage observer / response metadata observer 接入

建议新增：

```ts
protected getContextWindowConfig(): ContextWindowConfig | undefined
protected createContextOrchestrator(): ContextOrchestrator | undefined
```

### 2.3 message/manager.ts

`messageManager` 不应继续承担完整上下文裁剪职责，它更适合做：

- 输入消息规范化
- tool pair 基础修复
- memory messages 注入
- fallback 级固定窗口裁剪

真正的预算判定和分层压缩，应由 context orchestrator 在 runtime 中统一调度。

### 2.4 message/types.ts

需要为消息增加：

- round grouping 元数据
- response metadata
- compact boundary / summary 标识
- usage snapshot 关联
- preserved segment 关联

## 3. 模型层契约扩展

`packages/model/src/types.ts` 当前不够支撑上下文管理，至少要补充以下内容。

### 3.1 请求扩展

```ts
interface ModelRequest {
  model: string;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
  metadata?: Metadata;
  observer?: ModelObserver;
  signal?: AbortSignal;
  contextMetadata?: {
    apiViewId?: string;
    compactBoundaryId?: string;
    thresholdLevel?: string;
  };
}
```

### 3.2 响应扩展

```ts
interface ModelResponseMetadata {
  providerResponseId?: string;
  providerRequestId?: string;
  iterationId?: string;
  usage?: ModelUsage;
  iterationStats?: IterationContextStats;
  cacheHit?: boolean;
}
```

最终 `ModelResponse` 和 stream 完成事件都应能携带这些字段。

### 3.3 流式事件扩展

流式场景下，建议在 `done` 或独立 `response_metadata` 事件中返回：

- `providerResponseId`
- `usage`
- `iterationStats`

否则 `stream()` 将无法与 `run()` 共用同一套混合计数逻辑。

## 4. 运行时状态扩展

建议新增统一状态：

```ts
interface ContextRuntimeState {
  lastUsageSnapshot?: UsageSnapshot;
  compactCircuitBreaker: CompactCircuitBreakerState;
  activeBoundaryId?: string;
  lastProjectedApiViewId?: string;
  contextCollapseState?: ContextCollapseState;
  toolResultStorageState?: ToolResultStorageState;
  sessionMemoryState?: SessionMemoryState;
}
```

这个状态可挂在 agent runtime state 中，或以独立 context state 方式管理，但必须可 checkpoint。

## 5. 推荐接口定义

### 5.1 总 orchestrator

```ts
interface ContextOrchestrator {
  prepareRequest(input: PrepareRequestInput): Promise<PreparedRequest>;
  recoverFromError(input: RecoverFromErrorInput): Promise<RecoverFromErrorOutput>;
  onModelSuccess(input: OnModelSuccessInput): Promise<void>;
}
```

### 5.2 prepareRequest 输出

```ts
interface PreparedRequest {
  apiView: ApiView;
  measurement: ContextBudgetMeasurement;
  thresholdStatus: ContextThresholdStatus;
  allowedTools: ToolDefinition[];
  rehydrationPackage?: RehydrationPackage;
}
```

### 5.3 onModelSuccess 责任

- 写入 usage snapshot
- 写入 provider response metadata
- 更新 api round grouping
- 更新 microcompact 热度与工具结果访问热度
- 更新 session memory 抽取源

## 6. run() / stream() 的统一行为

这是实现中的强制要求。

### 6.1 不允许行为分叉

以下行为必须在 `run()` 与 `stream()` 中保持一致：

- 压缩阈值判断
- auto compact 触发
- reactive compact
- usage snapshot 写回
- blocking 阻断

### 6.2 推荐做法

抽出公共的 `prepareRequest()` 与 `handleModelErrorRecovery()`，避免在两个主循环中复制逻辑后逐渐漂移。

## 7. 与现有错误体系整合

`packages/model/src/errors.ts` 已有 `CONTEXT_OVERFLOW` 基础。接入时建议定义统一分类器：

```ts
type ContextFailureKind =
  | "prompt_too_long"
  | "context_overflow"
  | "media_too_large"
  | "max_output_tokens"
  | "unknown";
```

然后由 recovery orchestrator 统一处理，而不是在 runtime 中散落多个 provider 特例判断。

## 8. 事件、遥测与调试要求

建议在 agent 层新增以下事件：

- `context_budget_measured`
- `context_warning_entered`
- `context_auto_compact_triggered`
- `context_blocking_triggered`
- `context_layer_applied`
- `context_recovery_retry`
- `context_usage_snapshot_updated`

每个事件至少应包含：

- 当前 tokens
- threshold level
- layer 名称
- tokens before / after
- response id 或 iteration id

## 9. 测试计划

### 9.1 单元测试

建议新增目录：

```text
packages/agent/test/context/
```

建议测试文件：

- `api-view.test.ts`
- `budget.test.ts`
- `thresholds.test.ts`
- `grouping.test.ts`
- `tool-result-budget.test.ts`
- `history-snip.test.ts`
- `microcompact.test.ts`
- `context-collapse.test.ts`
- `session-memory-compact.test.ts`
- `auto-compact.test.ts`
- `recovery.test.ts`
- `rehydration.test.ts`

### 9.2 单元测试必须覆盖

- usage + estimation 混合计数
- JSON 与普通文本不同估算系数
- tool_use / tool_result 原子保留
- thinking chunk 分组保留
- history snip 按 round group 裁剪
- compact boundary 创建与链式追踪
- session memory compact 快速路径
- summary prompt 结构化输出格式化
- PTL compact request 重试
- cleanup 后状态重置

### 9.3 集成测试

建议在 agent runtime 集成测试中覆盖：

1. 长会话进入 warning 但不压缩。
2. 长会话进入 auto compact，并成功继续执行。
3. provider 返回 prompt too long，触发 reactive compact 并重试成功。
4. stream 模式与 run 模式在相同输入下进入相同阈值状态。
5. checkpoint 后 resume，仍能从最近 boundary 正确构造 API view。
6. 工具密集型会话中 tool result budget 和 microcompact 优先于 auto compact 生效。
7. 多次连续压缩失败后熔断生效。

### 9.4 回归测试

必须准备以下回归样本：

- 超长纯文本对话
- 大量 JSON 工具结果
- 含图片/文档消息
- 并行工具调用
- 多轮编辑文件并带计划更新
- 会话恢复后继续追问

## 10. 实施顺序

虽然目标是“完整实现所有功能”，但编码上仍建议按依赖顺序推进：

1. 扩展模型契约和消息元数据。
2. 建立 API view、budget、threshold 基础设施。
3. 实现 grouping 与安全截断。
4. 实现 tool result budget、history snip、microcompact。
5. 实现 context collapse 状态骨架。
6. 实现 session memory compact 与 auto compact。
7. 实现 reactive compact、compact-request PTL 重试、cleanup、rehydration。
8. 接入 runtime 的 `run()` / `stream()`。
9. 补齐 checkpoint/resume。
10. 完成测试与遥测。

注意，这个顺序是编码依赖顺序，不意味着前面的阶段完成后就可以宣称功能完整。最终交付必须全部闭环。

## 11. 最终验收标准

只有同时满足以下条件，才能判定 `renx-code-v3` 已“完全实现 Claude Code 的上下文管理能力”：

- 长会话能通过多层压缩管线稳定运行。
- 压缩行为可观测，可解释，可恢复。
- `run()` 与 `stream()` 行为一致。
- 压缩边界、摘要、归档、保留段可持久化并在 resume 后继续使用。
- provider usage 被真正消费进预算系统，而不是只是记录日志。
- PTL、媒体过大、输出预算问题均有恢复分支。
- 压缩后工作上下文能恢复，而不是只剩一段摘要。
- 连续失败会熔断，不会无限重试。
- forked agent cache prefix 被用于摘要路径。
- 测试能覆盖以上关键路径。

如果只实现其中一部分，即便效果看起来“能压缩了”，也不能视为完成。
