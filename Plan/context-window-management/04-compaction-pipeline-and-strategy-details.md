# 04 - 压缩管线与策略细节

## 1. 文档目的

本文档定义完整压缩管线的层次、顺序、输入输出、适用条件、失败语义和实现要求。目标是让后续实现者能够一层一层写出 Claude Code 同级别的上下文压缩体系，而不是只做一个“大模型摘要器”。

## 2. 总体策略

Claude Code 的压缩不是单层策略，而是“轻量优先、语义兜底”的分层系统。`renx-code-v3` 必须采用同一思路，推荐顺序如下：

1. Stage 0（前置预算门禁）：Tool Result Budget（不计入五层）
2. Layer 1：History Snip
3. Layer 2：Microcompact
4. Layer 3：Context Collapse
5. Layer 4：Session Memory Compact
6. Layer 5：Auto Compact

其中 Layer 1-3 是轻量/可逆优先层，Layer 4-5 是总结型压缩层；Stage 0 用于在进入五层前先降低工具结果噪声。

## 3. Stage 0 - Tool Result Budget（前置门禁）

### 3.1 目标

防止大型工具结果长期污染后续每一轮上下文。

### 3.2 必须实现的能力

- 对超预算工具结果进行截断或引用替换。
- 每轮限制单条消息及整轮工具结果的总字符数。
- 优先保留最近使用、最近生成、仍与当前任务相关的工具结果。
- 被替换内容需保留 `_cacheRef` 或等价引用，便于调试和可能的恢复。

### 3.3 推荐接口

```ts
interface ToolResultBudgetResult {
  messages: RunMessage[];
  replacedToolResultIds: string[];
  cacheRefsCreated: string[];
  charsSaved: number;
}
```

### 3.4 行为要求

- 若工具结果较大但仍在尾部热点区，可保留原文。
- 若工具结果较旧或已被后续引用，可以替换为摘要性占位文本。
- 工具结果引用替换不能破坏 tool call / tool result 的逻辑配对。

## 4. Layer 1 - History Snip

### 4.1 目标

在不调用模型、不修改摘要状态的前提下，优先去掉最早的一部分历史轮次。

### 4.2 行为要求

- 以 API round 为单位裁剪，而不是按单条消息。
- 始终保留最近若干轮对话与当前活跃工具链。
- 若会破坏协议完整性，则必须调整截断点。

### 4.3 推荐配置

- `historySnipMinRecentRounds`
- `historySnipMaxDropRounds`
- `historySnipProtectToolRounds`

### 4.4 适用时机

应始终在更重的语义压缩之前执行，因为它无模型成本，且对近期上下文影响最小。

## 5. Layer 2 - Microcompact

### 5.1 目标

Microcompact 是每轮都可以尝试的轻量压缩层，主要处理“冷却后的工具结果”和缓存化内容，不应该等到真正超限再第一次触发。

### 5.2 应具备的行为

- 清理明显过时的工具结果。
- 对旧工具结果使用缓存引用代替原始内容。
- 支持基于时间和最近访问热度的微压缩。
- 支持重复调用时的幂等行为。

### 5.3 状态要求

系统需要维护：

- 工具结果热度/最近访问时间
- microcompact 已处理标记
- microcompact 缓存引用表

### 5.4 为什么必须独立成层

若把 microcompact 混进 auto compact：

- 每次只能靠摘要来降 token，成本高。
- 工具结果这类高占比噪音无法被持续清理。
- 用户长工具链会话会过早进入重量级压缩。

## 6. Layer 3 - Context Collapse

### 6.1 目标

对中间历史片段进行可逆折叠，而不是直接写死成不可恢复摘要。

### 6.2 与 Auto Compact 的区别

| 能力 | Context Collapse | Auto Compact |
| --- | --- | --- |
| 是否可逆 | 是，至少逻辑上可追踪 | 否，主要靠摘要恢复 |
| 粒度 | 片段级/提交级 | 会话段级 |
| 成本 | 低到中 | 高 |
| 目标 | 让 API view 变小 | 真正重新组织历史 |

### 6.3 必须对齐的行为契约

虽然本地源码中未完全展开全部内部算法，但可以确认必须有以下外部行为：

- API view 投影前可应用 collapse 状态。
- collapse 状态可被清空、重建、持久化。
- 压缩失败或恢复时可先 drain/clear collapse，再进入 reactive compact。
- collapse 的提交与快照可进入日志或状态存储。

### 6.4 推荐抽象

```ts
interface ContextCollapseState {
  commits: ContextCollapseCommit[];
  snapshots: ContextCollapseSnapshot[];
  activeProjectionId?: string;
}
```

## 7. Layer 4 - Session Memory Compact

### 7.1 目标

当会话记忆已经提前抽取完毕时，直接将其作为摘要结果使用，绕过额外 LLM 摘要请求，做到零额外延迟或近零成本。

### 7.2 行为要求

- 只在 session memory 足够新、足够完整时启用。
- 仍然必须生成 summary message 与 compact boundary。
- 仍然必须记录覆盖范围、保留尾部、恢复锚点。

### 7.3 启用条件

推荐至少满足以下条件：

- 会话记忆存在且未过期。
- 最近改动没有显著偏离记忆内容。
- 当前上下文超限程度适合使用现成摘要而非重新总结。

## 8. Layer 5 - Auto Compact

### 8.1 目标

当前面几层压缩仍不足以把上下文拉回安全区时，执行结构化语义摘要。

### 8.2 摘要请求必须具备的约束

- 仅允许单轮。
- 禁止任何工具调用。
- 摘要输入前先 strip 掉图片和文档实体。
- 摘要输出必须是结构化格式，而不是自由文本。

### 8.3 结构化 9 段式摘要

摘要必须至少覆盖以下部分：

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and Fixes
5. Problem Solving
6. All User Messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

### 8.4 Prompt 要求

摘要 prompt 必须：

- 包含明确禁止工具的 preamble，建议命名为 `NO_TOOLS_PREAMBLE` 或等价常量。
- 告知模型只输出结构化摘要。
- 限制格式，避免返回多余思考草稿。
- 后处理时去除 `<analysis>` 或等价草稿区块。

### 8.5 输出组装

Auto compact 完成后，必须构造：

- compact summary message
- compact boundary message
- preserved tail
- 归档映射
- post-compact 恢复所需注入项

同时建议保留原始摘要请求与格式化后摘要结果的关联 id，便于后续排查“模型返回了分析草稿但格式化器裁掉后关键信息丢失”的问题。

## 9. 图片与文档剥离

### 9.1 目标

防止压缩请求本身携带媒体块而再次导致过长或 provider 拒绝。

### 9.2 行为要求

- 普通消息中的图片块替换为 `[image]`
- 文档块替换为 `[document]`
- tool_result 内嵌媒体块也要处理
- 替换逻辑只作用于压缩请求视图，不应破坏 canonical history 原始记录

## 10. 压缩管线编排

推荐使用统一 orchestrator：

```ts
interface ContextCompactionOrchestrator {
  compact(input: CompactInput): Promise<CompactOutput>;
}
```

推荐执行顺序：

```text
1. 从最近 compact boundary 后投影 messages
2. 应用 tool result budget
3. 应用 history snip
4. 应用 microcompact
5. 应用 context collapse
6. 测量 token
7. 若仍超阈值，优先尝试 session memory compact
8. 若不满足条件，再执行 auto compact
9. 生成 boundary、summary、archive、preserved tail
10. 进入 rehydration 与 cleanup
```

## 11. 每层的产物要求

每一层都不应只返回新的消息数组，至少要返回：

```ts
interface CompactionLayerResult {
  layer:
    | "tool_result_budget"
    | "history_snip"
    | "microcompact"
    | "context_collapse"
    | "session_memory"
    | "auto_compact";
  messages: RunMessage[];
  tokensBefore?: number;
  tokensAfter?: number;
  changed: boolean;
  metadata?: Record<string, unknown>;
}
```

这样后续日志、调试、回归测试才能知道是哪一层真正生效。

## 12. 层间协作规则

### 12.1 轻量层可以连续叠加

Tool result budget、history snip、microcompact 可以连续多层叠加，且通常不会产生新的 boundary。

### 12.2 重量层必须写入边界

Session memory compact 和 auto compact 完成后必须写入 boundary。

### 12.3 Collapse 与 Reactive Compact 的关系

当出现 provider PTL 时，系统可先 drain/clear collapse 状态，再决定是否进入 reactive compact。这是因为 collapse 投影视图可能已经引入额外复杂度或缓存不一致。

## 13. 失败语义

每一层都必须定义失败语义：

- 轻量层失败时可跳过到下一层，但要记录原因。
- session memory compact 不可用时可回退到 auto compact。
- auto compact 失败时进入恢复分支或熔断。
- 如果任何层导致协议完整性受损，应立即终止本轮压缩。

## 14. 验收要求

本模块完成后，必须保证：

- 不同压缩层有清晰职责，而不是一个大函数。
- Stage 0 + 五层压缩都能单独观测，不会混成黑盒。
- 压缩请求不会因为图片/文档块而轻易再次 PTL。
- 摘要输出是结构化可解析的，不是自由发挥文本。
- session memory 与 auto compact 可以作为两个明确分支存在。
