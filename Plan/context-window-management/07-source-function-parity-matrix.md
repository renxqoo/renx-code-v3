# 07 - Claude Code 源码函数对齐矩阵

## 1. 文档目的

前六份文档已经定义了“要实现什么”和“怎么实现”。本文档进一步解决最后一个常见问题：

- Claude Code 的某个关键函数，在 `renx-code-v3` 里到底应该对应到哪个模块、哪个接口、哪个状态对象？

本文档不是源码逐行翻译，而是做“行为职责映射”。目标是让后续实现者不必反复来回对照两个仓库，直接知道每个关键逻辑该落到哪里。

## 2. 使用方式

建议实现时按下面的顺序使用本矩阵：

1. 先找到 Claude Code 中正在参考的函数或文件。
2. 看本矩阵给出的 `renx-code-v3` 目标模块和推荐接口。
3. 先对齐外部行为，再决定是否复刻内部细节。

如果本矩阵和前面设计文档发生冲突，以前面六份设计文档定义的行为契约为准。

## 3. Query Loop 总映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 必须实现的行为 |
| --- | --- | --- | --- |
| `src/query.ts` | 模型调用前的上下文投影、预算判断、压缩触发、错误恢复 | `packages/agent/src/runtime.ts` + `packages/agent/src/context/index.ts` | `run()` / `stream()` 都走统一 prepare/recover 流程 |
| `docs/query-loop-overview.md` | query loop 架构说明 | `Plan/01` + `Plan/06` | 用作整体执行顺序的唯一口径 |

## 4. Token 与预算映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| `src/utils/tokens.ts` `tokenCountWithEstimation` | usage + 增量估算混合计数 | `packages/agent/src/context/budget.ts` | `measure(input): Promise<ContextBudgetMeasurement>` |
| `src/utils/tokens.ts` `finalContextTokensFromLastResponse` | 从最近响应或 iteration 中取真实上下文占用 | `packages/agent/src/context/budget.ts` | `readLatestUsageSnapshot(state)` |
| `docs/steps/step-01-02-context-budget.md` | 预算、上下文窗口、输出保留口径 | `Plan/02` | 用于统一阈值公式 |

### 4.1 必须对齐的行为

- 优先使用最后一次 iteration 的 `contextTokens`。
- 若无 iteration 级数据，则回退到 response usage。
- 再无则回退到本地估算。
- 估算口径必须覆盖 system prompt、tools、messages、rehydration。

## 5. 边界与消息视图映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| `src/utils/messages.ts` `createCompactBoundaryMessage` | 创建压缩边界消息 | `packages/agent/src/context/persistence.ts` | `createCompactBoundary(payload)` |
| `src/utils/messages.ts` `getMessagesAfterCompactBoundary` | 从最近边界之后投影消息视图 | `packages/agent/src/context/api-view.ts` | `projectAfterBoundary(history)` |
| `src/types/logs.ts` | collapse commit / snapshot / compact log 数据结构 | `packages/agent/src/context/types.ts` | `ContextCollapseState`、`CompactEventLog` |

### 5.1 renx 中必须新增的类型

- `CompactBoundaryPayload`
- `CompactSummaryPayload`
- `PreservedSegment`
- `UsageSnapshot`
- `ContextRuntimeState`

## 6. 分组与安全截断映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| `src/services/compact/grouping.ts` `groupMessagesByApiRound` | 按 API 轮次分组 | `packages/agent/src/context/grouping.ts` | `groupMessagesByApiRound(messages)` |
| `src/services/compact/sessionMemoryCompact.ts` `adjustIndexToPreserveAPIInvariants` | 修正裁剪点，确保协议完整性 | `packages/agent/src/context/grouping.ts` | `adjustIndexToPreserveApiInvariants(messages, index)` |
| `src/services/compact/sessionMemoryCompact.ts` `calculateMessagesToKeepIndex` | 计算安全保留起点 | `packages/agent/src/context/grouping.ts` | `calculateMessagesToKeepIndex(input)` |

### 6.1 必须保留的原子单元

实现 `grouping.ts` 时必须把以下内容视为不可拆分组：

- 同一 assistant `message.id` 的 thinking / text / tool_use chunks
- tool_use 与对应 tool_result
- 同一 provider response 的 streaming chunks

## 7. Tool Result Budget 映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| `src/utils/toolResultStorage.ts` | 大工具结果缓存引用与预算控制 | `packages/agent/src/context/tool-result-budget.ts` | `applyToolResultBudget(input)` |
| `src/services/compact/microCompact.ts` | 微压缩中处理旧工具结果 | `packages/agent/src/context/microcompact.ts` | `runMicrocompact(input)` |

### 7.1 状态对象

建议新增：

```ts
interface ToolResultStorageState {
  refs: Record<string, ToolResultCacheRef>;
  lastTouchedAtByToolResultId: Record<string, string>;
  replacedToolResultIds: string[];
}
```

## 8. 历史裁剪与微压缩映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| `src/services/compact/microCompact.ts` | 冷工具结果微压缩、缓存化 | `packages/agent/src/context/microcompact.ts` | `runMicrocompact(input)` |
| query loop 中的 history snip | 最早历史轮次裁剪 | `packages/agent/src/context/history-snip.ts` | `applyHistorySnip(input)` |

### 8.1 行为分界

- `history-snip.ts` 负责“去掉最老轮次”。
- `microcompact.ts` 负责“收缩旧工具结果与热点外内容”。
- 两者不能混成一个“大裁剪函数”，否则日志和调试会失去清晰度。

## 9. Context Collapse 映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| `src/types/logs.ts` collapse commit/snapshot | collapse 提交与快照 | `packages/agent/src/context/context-collapse.ts` | `createCollapseCommit()` / `applyCollapseProjection()` |
| query loop 中 collapse projectView | 对 API view 应用折叠视图 | `packages/agent/src/context/api-view.ts` + `context-collapse.ts` | `applyContextCollapse(apiView, state)` |

### 9.1 行为要求

虽然本地源码未完整展开内部实现，但必须对齐以下外部效果：

- 有独立 collapse 状态。
- API view 可应用 collapse projection。
- reactive compact 前可 clear/drain。
- checkpoint/resume 可恢复。

## 10. Session Memory Compact 映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| `src/services/compact/sessionMemoryCompact.ts` | 用现有 session memory 快速压缩 | `packages/agent/src/context/session-memory-compact.ts` | `trySessionMemoryCompact(input)` |

### 10.1 必须包含的步骤

1. 判断 session memory 是否可用。
2. 计算 messages-to-keep 安全边界。
3. 生成 summary message。
4. 生成 compact boundary。
5. 构建 post-compact messages。

## 11. Auto Compact 映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| `src/services/compact/autoCompact.ts` | 自动压缩触发与熔断 | `packages/agent/src/context/auto-compact.ts` | `maybeAutoCompact(input)` |
| `src/services/compact/compact.ts` `compactConversation` | 执行压缩主流程 | `packages/agent/src/context/auto-compact.ts` + `recovery.ts` | `compactConversation(input)` |
| `src/services/compact/prompt.ts` | 结构化摘要 prompt 与输出格式化 | `packages/agent/src/context/summary-prompt.ts` | `buildCompactPrompt()` / `formatCompactSummary()` |

### 11.1 摘要相关必须对齐的行为

- 使用 `NO_TOOLS_PREAMBLE` 或等价常量。
- 禁止工具调用。
- 仅允许单轮。
- 格式化时剥离 `<analysis>` 草稿。
- 输出必须进入 summary message + boundary message 组装。

## 12. PTL 重试与压缩恢复映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| `src/services/compact/compact.ts` `truncateHeadForPTLRetry` | 压缩请求自身 PTL 时逐步截断重试 | `packages/agent/src/context/recovery.ts` | `retryCompactRequestIfNeeded(input)` |
| query loop 中 PTL 错误处理 | 主请求 PTL / media-too-large 恢复 | `packages/agent/src/context/recovery.ts` + `runtime.ts` | `recoverFromModelError(input)` |

### 12.1 必须区分的两种错误路径

- 主请求过长后触发的 reactive compact。
- 摘要请求自身过长后的 compact-request retry。

这两者不能共用一个“直接再裁一点消息”的简单分支。

## 13. Post-Compact Rehydration 映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| `src/services/compact/compact.ts` `buildPostCompactMessages` | 构建压缩后恢复消息 | `packages/agent/src/context/rehydration.ts` | `buildPostCompactMessages(input)` |
| hooks / plans / skills 相关 query 逻辑 | 恢复工作上下文 | `packages/agent/src/context/rehydration.ts` | `collectRehydrationPackage(input)` |

### 13.1 必须恢复的内容

- 最近文件
- plan 与 mode 指令
- skills
- session start hooks
- MCP delta
- deferred tools delta
- agent listing delta

## 14. Post-Compact Cleanup 映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| `src/services/compact/postCompactCleanup.ts` | 压缩后清理缓存和状态 | `packages/agent/src/context/cleanup.ts` | `cleanupAfterCompact(input)` |

### 14.1 必须清理的状态

- microcompact 中间状态
- context collapse 活跃投影
- 用户上下文缓存
- memory files 缓存
- system prompt section 缓存

## 15. Forked Agent 映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| `src/utils/forkedAgent.ts` `runForkedAgent` | 复用主线程 cached prefix 做单轮摘要 | `packages/agent/src/context/auto-compact.ts` 或 `packages/agent/src/context/forked-compact.ts` | `runForkedCompact(input)` |

### 15.1 必须满足的约束

- `maxTurns: 1`
- `allowTools: false`
- cache-safe 参数尽量稳定
- 使用主线程 system prompt prefix

## 16. Runtime 与 Base 接入映射

| Claude Code 源点 | 主要职责 | renx 目标位置 | 推荐接口 |
| --- | --- | --- | --- |
| query loop 主入口 | 每轮调用前准备请求 | `packages/agent/src/runtime.ts` | `prepareRequest()` |
| query loop 错误恢复 | 统一处理 PTL / media / output 错误 | `packages/agent/src/runtime.ts` | `handleModelErrorRecovery()` |
| agent 初始化配置 | 注入 context 配置和 orchestrator | `packages/agent/src/base.ts` | `getContextWindowConfig()` / `createContextOrchestrator()` |

## 17. Model 层映射

| Claude Code 行为 | renx 目标位置 | 必须补充 |
| --- | --- | --- |
| provider response id 写回 | `packages/model/src/types.ts` | `providerResponseId` |
| usage 写回 | `packages/model/src/types.ts` | `ModelUsage` |
| iteration 级上下文统计 | `packages/model/src/types.ts` | `IterationContextStats` |
| stream done 携带 metadata | `packages/model/src/types.ts` + provider adapters | `response_metadata` 或等价 done payload |

## 18. 测试映射

| Claude Code 行为 | renx 测试位置 | 测试重点 |
| --- | --- | --- |
| usage + estimate 混合计数 | `packages/agent/test/context/budget.test.ts` | usage 回溯与增量估算 |
| groupMessagesByApiRound | `packages/agent/test/context/grouping.test.ts` | thinking/tool/result 原子性 |
| auto compact + boundary | `packages/agent/test/context/auto-compact.test.ts` | summary + boundary + preserved tail |
| reactive compact | `packages/agent/test/context/recovery.test.ts` | provider PTL 恢复 |
| run/stream 一致性 | runtime 集成测试 | 同输入同阈值同恢复行为 |

## 19. 实现时的禁止事项

为避免偏离 Claude Code 行为，本矩阵明确禁止以下做法：

- 不要把 `query.ts` 的职责粗暴地全部塞进 `messageManager`。
- 不要只实现 auto compact，而省略 tool result budget、history snip、microcompact。
- 不要把 `compact_boundary` 简化成一条普通摘要消息。
- 不要让 PTL 恢复仅靠“减少 maxTokens”而没有真正压缩输入视图。
- 不要让 `stream()` 走另一套阈值和恢复逻辑。

## 20. 结论

如果前六份文档定义了“目标系统长什么样”，那么本文档定义的就是“Claude Code 每一个关键逻辑点，在 renx 里究竟应该落到哪里”。后续实现应优先按本矩阵建立文件、接口、状态和测试映射，再逐步填充内部实现。
