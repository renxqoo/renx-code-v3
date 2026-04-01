# 03 - 消息模型、压缩边界与持久化

## 1. 文档目的

上下文管理能否稳定实现，取决于消息模型是否足够表达以下事实：

- 哪些消息属于同一次 API 响应。
- 哪些 assistant 片段必须作为原子单元保留。
- 何处发生过压缩。
- 压缩后保留了哪一段，归档了哪一段。
- resume 时从哪里继续恢复 API 视图。

本文档给出消息结构扩展、边界消息定义、分组与安全截断规则，以及 checkpoint/resume 的持久化要求。

## 2. 为什么当前消息模型不够

`renx-code-v3` 当前消息结构偏向简单对话与工具调用记录，缺少以下能力：

- provider response 级关联
- API round 级分组
- thinking / text / tool_use 同一 assistant 响应的聚合关系
- compact boundary 元数据
- preserved segment 与 archived message ids
- 摘要来源追踪

没有这些字段时，任何“安全压缩”都只能停留在粗粒度裁剪，无法实现与 Claude Code 对齐的协议安全行为。

## 3. 推荐消息元数据扩展

### 3.1 运行消息扩展

建议为 `RunMessage` 增加上下文管理元数据容器，而不是把字段平铺到顶层：

```ts
interface RunMessageContextMetadata {
  providerResponseId?: string;
  providerRequestId?: string;
  iterationId?: string;
  apiRoundId?: string;
  chunkGroupId?: string;
  isCompactBoundary?: boolean;
  isCompactSummary?: boolean;
  compactReason?: "auto" | "manual" | "error" | "session_memory";
  compactStrategy?:
    | "tool_result_budget"
    | "history_snip"
    | "microcompact"
    | "context_collapse"
    | "session_memory"
    | "auto_compact"
    | "reactive_compact";
  summarizedMessageIds?: string[];
  archivedMessageIds?: string[];
  deletedToolIds?: string[];
  preservedSegment?: PreservedSegment;
}
```

### 3.2 Provider usage 快照

建议在 assistant 响应或 iteration 级状态中保留：

```ts
interface UsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  contextTokens?: number;
  capturedAt: string;
}
```

### 3.3 分组关系字段

至少需要以下分组标识之一：

- `apiRoundId`
- `providerResponseId`
- 同一响应共享的 `message.id`

推荐保留多个字段，而不是只依赖一个字段推断。

## 4. Compact Boundary 的定义

### 4.1 边界消息用途

`compact_boundary` 不是普通摘要消息，它承担四个职责：

- 作为 API view 重新投影的起点。
- 记录本次压缩归档了哪些消息与工具结果。
- 记录保留段锚点，用于后续恢复或多次压缩链式追踪。
- 为 resume / checkpoint / UI 提供明确边界。

### 4.2 建议结构

```ts
interface CompactBoundaryPayload {
  trigger: "auto" | "manual" | "error" | "session_memory";
  strategy:
    | "session_memory"
    | "auto_compact"
    | "reactive_compact";
  preCompactTokenCount: number;
  postCompactTokenCount?: number;
  archivedMessageIds: string[];
  deletedToolIds: string[];
  preservedSegment: PreservedSegment;
  sourceSummaryMessageId?: string;
  compactedAt: string;
}
```

边界消息建议仍然作为普通 `RunMessage` 存储，但 `role` 可以是 `system` 或专门的内部 role。重点不在 role 名称，而在于它必须被 `getMessagesAfterCompactBoundary()` 一类逻辑识别。

### 4.3 Preserved Segment

建议定义：

```ts
interface PreservedSegment {
  headUuid?: string;
  anchorUuid?: string;
  tailUuid?: string;
  recentMessageIds: string[];
}
```

解释：

- `headUuid` 指压缩前保留头段锚点。
- `anchorUuid` 指本轮摘要与后续历史的连接点。
- `tailUuid` 指尾部保留段锚点。
- `recentMessageIds` 记录当前仍显式保留的末尾消息。

## 5. 摘要消息的定义

Auto compact 或 session memory compact 产生的摘要消息必须可追溯其来源，建议结构：

```ts
interface CompactSummaryPayload {
  strategy: "session_memory" | "auto_compact" | "reactive_compact";
  summaryFormat: "structured_9_sections";
  summarizedMessageIds: string[];
  preservedTailMessageIds: string[];
  generatedAt: string;
}
```

摘要消息必须与 boundary 消息同时出现，不能只有摘要没有边界。

## 6. API Round Grouping

### 6.1 为什么必须有分组

Prompt-Too-Long 恢复和安全截断不能按“单条消息”工作，必须按“API 轮次”工作。原因包括：

- 同一轮 assistant 响应可能拆成多条消息。
- 工具调用链跨多条消息，但逻辑上属于同一次轮次。
- 截断时若只切单条，很容易留下不完整协议。

### 6.2 分组规则

推荐实现 `groupMessagesByApiRound(messages)`，分组依据按优先级如下：

1. `apiRoundId`
2. `providerResponseId`
3. 同一 assistant `message.id`
4. 工具对链的连续关联

分组输出建议：

```ts
interface MessageRoundGroup {
  id: string;
  messageIds: string[];
  roles: Array<"system" | "user" | "assistant" | "tool">;
  containsToolUse: boolean;
  containsToolResult: boolean;
  containsThinking: boolean;
  tokenEstimate?: number;
}
```

### 6.3 Messages-To-Keep 计算

为了支持 session memory compact、history snip 和 PTL 重试，建议单独实现 `calculateMessagesToKeepIndex()` 或等价逻辑。其职责不是简单返回“第 N 条消息之后保留”，而是：

- 结合最近 compact boundary 计算可见主段起点。
- 结合 API round grouping 计算安全保留起点。
- 结合 tool/use/result/thinking 原子性规则对起点做修正。
- 在 session memory compact 场景下输出“可直接被摘要覆盖的最早安全索引”。

如果没有这个统一索引计算函数，多个压缩策略会各自实现截断逻辑，最终极易产生边界不一致。

## 7. Tool/Thinking 原子完整性

### 7.1 必须保留的原子单元

以下内容必须作为一个整体保留或删除：

- assistant thinking block 与同响应 text/tool_use block
- tool_use 与对应 tool_result
- 同一 provider response 的多段 assistant chunk

### 7.2 安全截断原则

实现时需要一个类似 `adjustIndexToPreserveAPIInvariants()` 的安全修正函数，规则如下：

- 若截断点落在 tool_use 前后，向前或向后扩展到完整配对边界。
- 若截断点落在同一 assistant `message.id` 的多个 chunk 中间，扩展到整组。
- 若截断点会留下孤立 tool_result，必须继续修正。

### 7.3 Thinking Block 保护

Claude Code 特别处理了 streaming 过程中被拆开的 thinking block。`renx-code-v3` 也必须具备同样意识：

- thinking 不一定和最终 text 在同一条消息里落库。
- 同一 message id 的 thinking/text/tool_use 必须按共享组处理。

## 8. Session Memory Compact 的特殊保留

当系统走 session memory compact 快速路径时：

- 摘要内容来自已有 session memory，而非新发起的摘要请求。
- 仍然必须插入 compact boundary。
- 仍然需要记录被覆盖的消息范围与 preserved segment。

不能因为没有调用 LLM，就省略边界与追踪元数据。

## 9. Checkpoint / Resume 持久化要求

以下状态必须进入 checkpoint 或等价会话存储：

- canonical history
- compact boundary 消息
- compact summary 消息
- preserved segment
- archived message ids
- tool result cache refs
- 最近 usage snapshot
- context collapse 的提交或快照状态
- session memory 索引

否则 resume 后系统无法正确回答“从哪里开始重新投影 API view”。

## 10. Resume 行为要求

恢复时应按以下顺序：

1. 加载 canonical history。
2. 定位最近 `compact_boundary`。
3. 恢复 tool result storage 与 archive refs。
4. 恢复 context collapse / session memory 状态。
5. 重建 API view。
6. 再执行常规预算与压缩管线。

resume 不能简单理解为“把消息列表读回来继续跑”。

## 11. 事件与审计建议

建议新增以下运行事件：

- `context_boundary_created`
- `context_summary_created`
- `context_resume_restored`
- `context_api_round_grouped`
- `context_safe_cut_adjusted`

这些事件能帮助判断是哪个边界、哪次裁剪、哪种修正规则影响了最终请求。

## 12. 验收要求

本模块完成后，必须保证：

- 可以准确找到最近一次压缩边界后的消息段。
- 任意一次裁剪都不会留下孤立 tool_result 或残缺 assistant 响应。
- 多次连续压缩后仍能追踪边界链。
- checkpoint / resume 后 API view 重建结果稳定一致。
- session memory compact 与 auto compact 在持久化语义上没有断层。
