# 05 - 恢复、重注入与 Forked Agent 缓存复用

## 1. 文档目的

上下文管理系统只有在“压缩失败、压缩后恢复、错误后重试”都被定义清楚时才算完整。本文档定义以下内容：

- reactive compact 的触发条件与恢复流程
- 压缩请求本身 PTL 时的重试策略
- 压缩完成后的 rehydration
- post-compact cleanup
- 连续失败熔断
- forked agent cache prefix 复用

## 1.1 与“Stage 0 + 五层压缩”口径的关系

本文件覆盖的是“压缩后的恢复系统”，不是新的压缩层。统一口径如下：

- Stage 0（前置预算门禁）：Tool Result Budget
- Layer 1-5（主动压缩路径）：History Snip、Microcompact、Context Collapse、Session Memory Compact、Auto Compact
- 本文档主题（恢复路径）：Reactive Compact、PTL 重试、Rehydration、Cleanup、Circuit Breaker

其中 `Reactive Compact` 属于错误恢复分支，不计入五层主动压缩。

## 2. Reactive Compact

### 2.1 触发条件

当 provider 返回以下错误时，应进入 reactive compact：

- prompt too long
- context overflow
- media too large
- 输入 token 超限的等价错误

如果是 max output tokens 相关错误，则进入相邻恢复分支，而不是简单归类为 PTL。

### 2.2 总体流程

```text
1. 捕获模型错误
2. 分类错误类型
3. 若为 PTL / media-too-large，先尝试清空或排空 collapse 视图
4. 重新投影 API view
5. 进入 reactive compact（恢复分支，不属于五层主动压缩）
6. 成功后写入 boundary、rehydration、cleanup
7. 以当前 step 重试模型调用
8. 超过重试上限则失败退出
```

### 2.3 配置要求

`packages/agent/src/types.ts` 中已有 `RecoveryConfig`，应扩展为真正生效的恢复配置：

```ts
interface RecoveryConfig {
  maxPromptTooLongRetries: number;
  maxOutputTokensRecoveryLimit: number;
  maxReactiveCompactAttempts: number;
  maxConsecutiveAutocompactFailures: number;
  maxCompactStreamingRetries: number; // 压缩请求 streaming 中断后最大重试次数，源码 MAX_COMPACT_STREAMING_RETRIES = 2
  maxOutputTokensForSummary: number; // 摘要请求最大输出 token，源码 MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
}
```

## 3. 压缩请求本身 PTL 的重试

### 3.1 为什么需要单独处理

真实场景中，发给“摘要模型”的压缩请求也可能过长。如果不处理，会出现：

- 主请求超长，进入 compact
- compact 请求自身也超长
- 系统直接失败或死循环

Claude Code 明确处理了这一点，`renx-code-v3` 也必须实现。

### 3.2 重试策略

推荐按 API round 分组后重试：

1. 先按 `groupMessagesByApiRound()` 分组。
2. 每次丢弃最早的一批轮次组。
3. 保留 synthetic user marker，说明这是“为适配 compact 请求而缩减输入”。
4. 最多重试固定次数，例如 3 次。
5. 若仍失败，再进入更激进的固定比例丢弃，例如最老 20% 轮次。

### 3.3 接口建议

```ts
interface CompactRetryResult {
  messages: RunMessage[];
  retries: number;
  droppedRoundGroupIds: string[];
  usedFallbackDropRatio?: number;
}
```

### 3.4 关键约束

- 必须按 round group 丢弃，不能按单条消息切。
- synthetic marker 不能污染 canonical history 原文，可只存在于 compact 请求视图。

## 4. Max Output Tokens 恢复

如果 provider 报错表明“输出预算配置过大”或“剩余可用上下文不足以容纳请求输出”，恢复流程应支持：

- 先降低 `maxOutputTokens`
- 重新计算 `effectiveContextWindow`
- 如仍不安全，再执行 reactive compact

这一路径不应和普通 PTL 路径混为一谈。

## 5. 压缩后的 Rehydration

### 5.1 为什么必须做

压缩会删除大量工作细节。如果压缩后直接继续运行，agent 很容易失去局部工作状态，表现为：

- 忘记刚刚编辑的文件
- 忘记 plan 与当前步骤
- 忘记已加载技能或 hooks
- 忘记 MCP 指令、deferred tools、agent 列表

因此，压缩后必须显式重注入必要上下文。

### 5.2 必须恢复的项目

以下项目要求与 Claude Code 行为对齐：

- 最近读取/修改的文件
- 当前计划内容
- Plan mode 或等价工作模式指令
- skills 附加说明
- session start hooks 结果
- MCP 服务器说明或工具提示
- deferred tools delta
- agent listing delta
- async agent attachments（与 Claude Code 源码 `createAsyncAgentAttachmentsIfNeeded()` 对齐，用于恢复异步子 agent 的上下文附件）

### 5.3 推荐接口

```ts
interface RehydrationPackage {
  recentFilesMessages: RunMessage[];
  planMessages: RunMessage[];
  skillMessages: RunMessage[];
  hookMessages: RunMessage[];
  mcpMessages: RunMessage[];
  deferredToolMessages: RunMessage[];
  agentListingMessages: RunMessage[];
  asyncAgentAttachmentMessages: RunMessage[];
}
```

### 5.4 最近文件恢复

建议定义预算：

- 最多恢复最近 5 个文件
- 单文件重注入预算上限单独配置
- 若文件过大，恢复摘要或关键片段，而不是全量原文

推荐默认恢复预算可参考 Claude Code 的控制思路：

- 最近文件总预算约 50K tokens
- 单文件默认上限约 5K tokens
- plan 注入预算约 5K tokens
- skills 注入预算约 25K tokens

这些值不是要求写死到实现里，但文档层面必须明确“恢复也是预算管理问题”，否则压缩完后 rehydration 很容易重新把上下文顶回危险区。

### 5.5 恢复注入顺序

推荐顺序：

1. summary message
2. compact boundary
3. recent files
4. plan / mode instructions
5. skills
6. hooks
7. deferred tools / agent listing / MCP deltas / async agent attachments
8. preserved tail

这样既能保持压缩逻辑连贯，也能把恢复消息控制在可预测顺序中。

## 6. Post-Compact Cleanup

压缩完成后，必须执行清理，避免旧投影状态污染新一轮请求。

### 6.1 必须清理的状态

- microcompact 缓存或中间状态
- context collapse 活跃投影
- user context cache
- memory files cache
- system prompt section cache
- 旧的 compact request 临时数据

### 6.2 推荐接口

```ts
interface PostCompactCleanup {
  resetMicrocompact(): void;
  resetContextCollapse(): void;
  clearUserContextCache(): void;
  clearMemoryFileCache(): void;
  clearSystemPromptCaches(): void;
}
```

### 6.3 为什么 cleanup 不能省略

如果不清理：

- 刚压缩过的旧工具结果可能再次混入 API view
- collapse 投影可能和新边界冲突
- 预算统计可能继续使用旧缓存

## 7. 自动压缩熔断

### 7.1 目标

避免连续失败的自动压缩无限重试，浪费请求成本并拖垮运行时。

### 7.2 行为要求

- 记录连续 auto compact 失败次数。
- 达到上限后暂停自动压缩，转入显式错误路径。
- 成功一次后清零失败计数。

### 7.3 推荐字段

```ts
interface CompactCircuitBreakerState {
  consecutiveAutocompactFailures: number;
  openedAt?: string;
  lastFailureReason?: string;
}
```

## 8. Forked Agent Cache Prefix 复用

### 8.1 目标

压缩摘要请求应优先通过 forked agent 完成，以复用主线程已有 cached prompt prefix，减少 token 成本与延迟。

### 8.2 行为要求

- forked agent 只允许单轮 `maxTurns: 1`
- 禁止工具调用
- 尽量避免改变会影响 cache key 的请求参数
- 共享主线程 system prompt 前缀与稳定上下文

### 8.3 推荐抽象

```ts
interface ForkedCompactRequest {
  systemPrompt: string;
  messages: RunMessage[];
  model: string;
  maxTurns: 1;
  allowTools: false;
  cacheSafe: true;
}
```

### 8.4 Cache-safe 参数原则

摘要调用中应尽量避免额外传入与主请求差异过大的参数，例如：

- 不必要的随机采样参数变化
- 不稳定的 metadata 字段
- 无关的临时 tags

目标是最大化 cached prefix 命中率。

## 9. 恢复编排器

推荐为恢复流程定义单独 orchestrator：

```ts
interface ContextRecoveryOrchestrator {
  recoverFromModelError(input: RecoverInput): Promise<RecoverOutput>;
  retryCompactRequestIfNeeded(input: CompactRetryInput): Promise<CompactRetryResult>;
  rehydrateAfterCompact(input: RehydrateInput): Promise<RehydrationPackage>;
  cleanupAfterCompact(input: CleanupInput): Promise<void>;
}
```

## 10. 日志与事件建议

建议新增：

- `context_reactive_compact_started`
- `context_reactive_compact_succeeded`
- `context_reactive_compact_failed`
- `context_compact_retry_truncated`
- `context_rehydration_applied`
- `context_cleanup_completed`
- `context_circuit_breaker_opened`
- `context_forked_agent_compact_used`

## 11. 验收要求

本模块完成后，必须保证：

- 主请求 PTL 能触发 reactive compact 并成功重试。
- 摘要请求自身 PTL 时不会立刻失败，而会按 round group 截断重试。
- 压缩后 agent 能恢复最近工作上下文，而不是只剩一段摘要。
- cleanup 后不会出现旧投影或旧缓存再次污染新请求。
- 连续压缩失败到达上限后系统能及时熔断。
- 摘要请求优先走 forked agent cache 复用路径。
- 能清晰区分“主动压缩路径（Stage 0 + Layer 1-5）”与“错误恢复路径（Reactive Compact）”。
