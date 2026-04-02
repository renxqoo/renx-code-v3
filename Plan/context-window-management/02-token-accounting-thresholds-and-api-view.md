# 02 - Token 计数、阈值体系与 API 视图

## 1. 文档目的

本文档定义三件事：

1. `renx-code-v3` 应如何构造“本轮真正发给模型的消息视图”。
2. 应如何计算上下文 token 占用。
3. 应如何定义 warning、compact、error、blocking 四级阈值。

没有这三部分，后面的压缩管线就会失去统一口径。

## 2. API View 的定义

### 2.1 输入

API view 的输入不是单纯的消息数组，而是以下对象：

- canonical history
- system prompt
- allowed tools
- compact boundary 状态
- tool result storage / cache refs
- 当前 session memory 状态
- context collapse 状态

### 2.2 输出

输出必须至少包含：

```ts
interface ApiView {
  messages: RunMessage[];
  projectedFromMessageIds: string[];
  compactBoundaryId?: string;
  preservedSegment?: PreservedSegment;
  tokenEstimate?: number;
}
```

说明：

- `messages` 是发送给模型的最终消息列表。
- `projectedFromMessageIds` 用于调试和追踪哪些 canonical message 被投影进了本轮。
- `compactBoundaryId` 表示本轮视图从哪个压缩边界之后开始。
- `preservedSegment` 表示头锚点、尾锚点、保留尾部等信息。

### 2.3 投影顺序

推荐投影顺序如下：

1. 从 canonical history 找到最近一次 `compact_boundary`。
2. 取边界之后的主消息段。
3. 应用 tool result budget 投影。
4. 应用 history snip。
5. 应用 microcompact。
6. 应用 context collapse project view。
7. 得到最终 messages 供 token 测量。

如果没有 compact boundary，则以整个 canonical history 为基础。

## 3. Token 计数的目标口径

### 3.1 不允许只用纯估算

Claude Code 的关键设计之一，是不把 token 计数完全建立在字符长度估算上。正确做法是：

- 尽量利用最近一次模型真实返回的 `usage`。
- 只对 `usage` 之后新增的消息做估算。
- 将两部分累加，得到接近真实 API 上下文占用的数值。

推荐接口如下：

```ts
interface ContextTokenMeasurement {
  fromUsageTokens: number;
  estimatedDeltaTokens: number;
  systemPromptTokens: number;
  toolTokens: number;
  messageTokens: number;
  totalInputTokens: number;
  source: "usage_plus_estimate" | "estimate_only";
  basedOnResponseId?: string;
}
```

### 3.2 为什么混合计数是必须的

纯估算会带来三个问题：

- 随着历史变长，误差积累越来越大。
- tool calls、JSON、thinking blocks 的估算偏差更明显。
- 无法与 provider 实际返回的使用量对齐，导致 UI 与真实行为脱节。

### 3.3 真实 usage 的回溯点

实现时必须支持从最近一次模型响应的 usage 向前回溯到该响应对应的“首个 assistant 片段”。原因是 provider 可能把同一次响应拆成多条 streaming 事件或多条消息落库。

因此，消息模型必须支持至少以下任一关联：

- `providerResponseId`
- `iterationId`
- 同一轮 assistant message 的共享 `message.id`

如果只保留普通消息数组而没有轮次/响应关联，混合计数就会失真。

### 3.4 iteration 级统计优先级

如果 provider 或 model adapter 返回 iteration 级上下文统计，则应优先使用“最后一次 iteration 的 context tokens”作为最近真实上下文占用快照，再叠加后续增量估算。推荐优先级如下：

1. `lastIteration.contextTokens`
2. `usage.inputTokens`
3. 本地全量估算

原因是长流式响应或多阶段响应中，最后一轮 iteration 往往最接近真实最终输入视图。

## 4. 估算算法要求

### 4.1 基础估算

基础估算可以使用字符到 token 的近似系数，但必须允许按内容类型调整：

- 普通文本：建议 `chars / 4`
- JSON：建议 `chars / 2`
- 代码块：建议独立系数，通常高于普通自然语言
- 工具 schema：建议与 JSON 相同或略高

这部分与 Claude Code 中 `bytesPerTokenForFileType` 的思想一致。

### 4.2 估算输入项

估算必须覆盖：

- `systemPrompt`
- 所有 messages 的 role/name/content/toolCalls
- tools definitions
- 可能注入的 rehydration messages
- 边界消息和摘要消息本身

### 4.3 估算输出项

预算测量时不要只给一个总数，至少应提供：

```ts
interface ContextBudgetBreakdown {
  systemPromptTokens: number;
  messageTokens: number;
  toolTokens: number;
  rehydrationTokens: number;
  reserveTokens: number;
  totalProjectedInputTokens: number;
}
```

这是后续优化压缩层的基础。

## 5. 四级阈值体系

### 5.1 关键公式

推荐采用与 Claude Code 一致的思路：

```ts
effectiveContextWindow = modelContextWindow - reservedOutputTokens;
autoCompactThreshold = effectiveContextWindow - autoCompactBufferTokens;
thresholdBase = autoCompactEnabled ? autoCompactThreshold : effectiveContextWindow;
warningThreshold = thresholdBase - warningBufferTokens;
errorThreshold = thresholdBase - errorBufferTokens;
blockingThreshold = effectiveContextWindow - blockingHeadroomTokens;
```

其中：

- `reservedOutputTokens` 不是固定写死到 0.2 比例，而是显式参数。
- 实现上建议默认 `min(maxOutputTokens, 20000)` 进入输出保留逻辑。
- `autoCompactBufferTokens` 建议显式配置，不能只用百分比阈值。
- `warning/error` 建议都相对同一个 `thresholdBase` 计算，避免和 auto 阈值出现跨层倒挂。

### 5.2 阈值含义

| 级别 | 含义 | 行为 |
| --- | --- | --- |
| `warning` | 逼近风险区但未超压缩阈值 | 发遥测、UI 警告、记录预算趋势 |
| `auto_compact` | 需要主动压缩 | 执行多层压缩管线 |
| `error` | 即便压缩仍可能危险 | 升级警告，收紧工具预算 |
| `blocking` | 已没有安全 headroom | 禁止继续模型调用 |

说明：Claude Code 里 `warning` / `error` 是并行风险信号，工程上可保持两个布尔标记，也可在 `level` 字段中映射为有序等级，但必须保证阈值来源一致。

### 5.3 状态输出

预算模块应输出如下结构：

```ts
interface ContextThresholdStatus {
  level: "healthy" | "warning" | "auto_compact" | "error" | "blocking";
  effectiveContextWindow: number;
  warningThreshold: number;
  autoCompactThreshold: number;
  errorThreshold: number;
  blockingThreshold: number;
  currentTokens: number;
  remainingTokens: number;
}
```

### 5.4 为什么不能只用一个 `compactionThreshold`

只有一个阈值会导致：

- 无法提前提示上下文压力。
- 无法在危险区执行更激进的预算收缩策略。
- 无法在明确阻塞前阻止无意义请求。

因此 `renx-code-v3` 必须彻底放弃单一 `0.8` 百分比阈值思路。

## 6. 预算计算流程

推荐将预算计算写成固定流程：

```text
1. 收集 model context window 与 max output tokens
2. 计算 effective context window
3. 获取最近一次真实 usage 快照
4. 投影 API view
5. 对 usage 之后增量消息做估算
6. 估算 system prompt、tools、rehydration messages
7. 汇总 breakdown 与 threshold status
8. 输出当前状态与建议动作
```

其中第 3 步和第 5 步必须使用同一套消息边界规则，不能出现“usage 对齐按 response id 回溯，而增量估算按单条消息追加”的双重口径，否则在并行工具调用和多 chunk assistant 响应下会出现重复计数或漏计数。

对应接口建议如下：

```ts
interface ContextBudgetEngine {
  projectApiView(input: ProjectApiViewInput): Promise<ApiView>;
  measure(input: MeasureContextInput): Promise<ContextBudgetMeasurement>;
  classify(input: ContextBudgetMeasurement): ContextThresholdStatus;
}
```

## 7. 预算统计与 UI/日志对齐

系统至少要记录以下字段：

- `contextWindow`
- `effectiveContextWindow`
- `currentTokens`
- `remainingTokens`
- `usageSource`
- `fromUsageTokens`
- `estimatedDeltaTokens`
- `thresholdLevel`
- `triggeredLayers`

原因是后续出现“为什么刚压缩完还是超限”这类问题时，必须能从日志中分辨是估算偏差、工具预算失控，还是 rehydration 把 token 又注回来了。

## 8. 对模型层的契约要求

为了支持混合计数，`packages/model/src/types.ts` 必须补充以下能力：

### 8.1 Response 级 usage

```ts
interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningTokens?: number;
}
```

### 8.2 响应标识

```ts
interface ResponseMetadata {
  providerResponseId?: string;
  providerRequestId?: string;
  iterationId?: string;
}
```

### 8.3 迭代级上下文统计

```ts
interface IterationContextStats {
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  maxOutputTokens?: number;
}
```

这些字段不一定都来自同一个 provider，但模型层必须提供统一容器，以便 agent 层不再依赖 provider 私有字段。

## 9. 推荐默认配置

建议在 `renx-code-v3` 中引入显式配置：

```ts
interface ContextWindowConfig {
  reservedOutputTokens: number;
  warningBufferTokens: number;
  autoCompactBufferTokens: number;
  errorBufferTokens: number;
  blockingHeadroomTokens: number;
  maxToolResultChars: number;
  historySnipMinRecentRounds: number;
}
```

推荐策略：

- `reservedOutputTokens` 默认按 `min(maxOutputTokens, 20000)` 计算。
- `warningBufferTokens` 与 `autoCompactBufferTokens` 分离。
- `blockingHeadroomTokens` 必须严格大于 0，不能让请求把窗口吃满。

## 10. 验收要求

本模块完成后，必须能回答以下问题：

- 当前对话真实占用了多少上下文。
- 这个值有多少来自 provider usage，有多少来自估算。
- 为什么进入 warning 或 auto compact 状态。
- 哪一部分输入最占上下文，system prompt、message 还是 tools。
- 压缩后为何仍未降到安全区，是历史太长、工具结果太大还是恢复注入过多。

如果这些问题无法从实现中直接得到答案，则说明预算设计仍不完整。
