# Claude Code 上下文压缩机制 深度分析

## 一、整体架构

上下文压缩是一个多层级的防御体系，由三个核心压缩策略和多个辅助机制组成：

```
┌─────────────────────────────────────────────────────┐
│                  上下文管理层次                        │
├─────────────────────────────────────────────────────┤
│ 1. Micro-compact (轻量级, 每轮触发)                    │
│    ├─ Time-based: 时间间隔触发，直接清除旧工具结果        │
│    └─ Cached: 使用 cache_edit API，不破坏缓存前缀       │
│                                                      │
│ 2. Session Memory Compact (中等, 保留原始消息)          │
│    └─ 用后台 forked agent 维护的笔记文件替代摘要         │
│                                                      │
│ 3. Full Compact (重量级, 完全摘要)                      │
│    ├─ 自动触发 (auto-compact)                          │
│    ├─ 手动触发 (/compact 命令)                          │
│    └─ 部分压缩 (partial compact: from/up_to)           │
│                                                      │
│ 4. Reactive Compact (API 413 错误时兜底)                │
│    └─ 捕获 prompt_too_long，事后压缩                    │
└─────────────────────────────────────────────────────┘
```

## 二、Token 计算与阈值体系

### 2.1 上下文窗口大小 (`src/utils/context.ts`)

| 模型 | 默认上下文窗口 | 最大输出 tokens |
|------|------------|--------------|
| claude-sonnet-4 / opus-4-5 | 200K | 32K-64K |
| claude-sonnet-4-6 / opus-4-6 (支持1M) | 200K 或 1M | 32K-128K |

1M 上下文通过三种方式启用：`[1m]` 模型名后缀、beta header、或 GrowthBook 实验。

### 2.2 关键阈值常量 (`autoCompact.ts:30-66`)

```
有效上下文窗口 = getContextWindowForModel() - min(maxOutputTokens, 20000)
Auto-compact 触发阈值 = 有效上下文窗口 - 13,000 (AUTOCOMPACT_BUFFER_TOKENS)
警告阈值 = 触发阈值 - 20,000
阻塞阈值 = 有效上下文窗口 - 3,000 (MANUAL_COMPACT_BUFFER_TOKENS)
```

以 200K 模型为例：

- 有效窗口 = 200,000 - 20,000 = **180,000**
- Auto-compact 触发 = 180,000 - 13,000 = **167,000** (~83%)
- 警告 = 167,000 - 20,000 = **147,000**
- 阻塞 = 180,000 - 3,000 = **177,000**

### 2.3 Token 计算核心函数 (`src/utils/tokens.ts:226`)

`tokenCountWithEstimation()` 是计算上下文大小的**规范函数**：

1. 从消息数组末尾向前扫描，找到最后一个包含 API usage 数据的 assistant 消息
2. 处理并行工具调用场景——相同 `message.id` 的多条 split 记录需回溯到第一条
3. 最终值 = `API usage(input + cache + output)` + `roughTokenCountEstimation(新增消息)`

## 三、三层压缩策略详解

### 3.1 Micro-compact (`src/services/compact/microCompact.ts`)

**目标**: 最小侵入式压缩，不清除整个对话，只清除旧工具结果。

**两条路径**:

#### 路径 A: Time-based Micro-compact

- **触发条件**: 距离上次 assistant 消息的时间间隔 > `gapThresholdMinutes`
- **动作**: 将所有 compactable 工具结果的内容替换为 `[Old tool result content cleared]`
- **保留最近 N 个** (`keepRecent`)，至少保留 1 个
- **直接修改消息内容**（因为缓存已经冷了，没有前缀需要保留）

#### 路径 B: Cached Micro-compact

- **触发条件**: 缓存前缀有效 + 主线程 + 支持的模型
- **动作**: 使用 Anthropic 的 `cache_edit` API，在 API 层面删除工具结果，**不修改本地消息内容**
- **优势**: 保持 prompt cache 完整，避免大量 cache_creation 开销
- 仅限主线程（`repl_main_thread`），forked agent 不会触发

**可压缩的工具集** (`COMPACTABLE_TOOLS`): FileRead, Shell, Grep, Glob, WebSearch, WebFetch, FileEdit, FileWrite

### 3.2 Session Memory Compact (`src/services/compact/sessionMemoryCompact.ts`)

**核心思想**: 不调用 API 做摘要，而是用后台维护的 session memory markdown 文件作为摘要来源。

**流程**:

1. 检查 feature flag `tengu_session_memory` + `tengu_sm_compact` 是否启用
2. 等待后台 session memory 提取完成
3. 根据 `lastSummarizedMessageId` 确定已摘要的消息边界
4. 从边界向后扩展，保证保留至少 `minTokens`(10K) + `minTextBlockMessages`(5) 条消息
5. 使用 `adjustIndexToPreserveAPIInvariants()` 确保不切断 tool_use/tool_result 配对和 thinking blocks
6. 将 session memory 内容作为摘要，保留的消息原封不动

**配置** (`SessionMemoryCompactConfig`):

- `minTokens`: 10,000 — 保留消息的最小 token 数
- `minTextBlockMessages`: 5 — 保留消息中最少含文本块的消息数
- `maxTokens`: 40,000 — 硬上限

**关键优势**: 保留原始消息（无损），不需要额外的 API 调用做摘要。

### 3.3 Full Compact (`src/services/compact/compact.ts`)

**核心流程** (`compactConversation()`, 行 387-763):

```
1. 执行 PreCompact hooks → 合并自定义指令
2. 选择路径:
   ├─ Cache-sharing forked agent (首选，复用主线程 prompt cache)
   │   └─ runForkedAgent() with maxTurns: 1, skipCacheWrite: true
   └─ Regular streaming (fallback)
       └─ queryModelWithStreaming() with thinking disabled
3. PTL 重试循环: 如果摘要请求本身触发 prompt_too_long:
   ├─ groupMessagesByApiRound() 按轮次分组
   └─ truncateHeadForPTLRetry() 丢弃最老的轮次，最多重试 3 次
4. 后处理:
   ├─ 清空 readFileState 缓存
   ├─ 创建 post-compact 文件附件 (最多 5 文件, 50K token 预算)
   ├─ 创建 plan/skill/agent/工具延迟加载附件
   ├─ 执行 SessionStart hooks
   ├─ 执行 PostCompact hooks
   └─ 通知 cache break 检测器
5. 返回 CompactionResult:
   ├─ boundaryMarker (系统消息, 标记压缩边界)
   ├─ summaryMessages (用户消息, 包含格式化摘要)
   ├─ attachments (文件/计划/技能/工具附件)
   └─ hookResults
```

**摘要 Prompt 结构** (`prompt.ts`):

- NO_TOOLS_PREAMBLE: 强制模型只输出文本，不调用任何工具
- 要求输出 `<analysis>` + `<summary>` 双 XML 块
- `<analysis>` 是草稿区，最终被 `formatCompactSummary()` 剥离
- 摘要包含 9 个固定部分：请求意图、技术概念、文件与代码、错误修复、问题解决、用户消息、待办任务、当前工作、下一步

**Partial Compact** (`partialCompactConversation()`, 行 772-1106):

- `from` 方向: 摘索指定索引**之后**的消息，保留之前的（前缀保留，cache 有效）
- `up_to` 方向: 摘索指定索引**之前**的消息，保留之后的（后缀保留，cache 失效）
- 用 `annotateBoundaryWithPreservedSegment()` 记录磁盘上的 UUID 链接关系

### 3.4 Auto-compact 决策流程 (`autoCompact.ts`)

```
autoCompactIfNeeded()
    │
    ├─ 熔断器检查: consecutiveFailures >= 3 → 跳过
    │
    ├─ shouldAutoCompact()
    │   ├─ 递归守卫: session_memory/compact/marble_origami → false
    │   ├─ isAutoCompactEnabled()? (DISABLE_COMPACT, DISABLE_AUTO_COMPACT, 用户配置)
    │   ├─ REACTIVE_COMPACT feature → 抑制主动压缩
    │   ├─ CONTEXT_COLLAPSE → 抑制主动压缩 (collapse 自身管理上下文)
    │   └─ tokenCountWithEstimation() >= getAutoCompactThreshold()?
    │
    ├─ trySessionMemoryCompaction() (优先尝试 SM 压缩)
    │   └─ 成功 → 返回
    │
    └─ compactConversation() (降级到传统全量压缩)
        ├─ 成功 → consecutiveFailures = 0
        └─ 失败 → consecutiveFailures++
```

**熔断器机制**: 连续 3 次自动压缩失败后停止重试。这是为了防止"上下文不可恢复地超出限制"导致每轮都发起注定失败的 API 调用（历史上曾造成每天约 25 万次无效 API 调用）。

## 四、Prompt Cache 优化

### 4.1 Cache-sharing Forked Agent (`compact.ts:1136-1248`)

关键设计：压缩时使用 `runForkedAgent()` 复用主线程的 prompt cache（system prompt + tools + context messages 的缓存前缀）。

- **不设置 maxOutputTokens**：因为这会导致 `budget_tokens` 被钳位，使 thinking config 不匹配，从而破坏缓存 key
- 日志记录 cache hit rate：`cache_read / (cache_read + cache_creation + input)`
- 失败时自动降级到 regular streaming path

### 4.2 Post-compact Cache 保护

- `notifyCompaction()` 通知 cache break 检测系统，避免将压缩后的 cache read 下降误判为 cache break
- `markPostCompaction()` 标记全局状态，防止压缩后立即触发重复压缩

## 五、后压缩状态恢复

### 5.1 文件附件恢复 (`createPostCompactFileAttachments()`)

- 重新读取最近访问的最多 **5 个文件**
- Token 预算: **50,000** 总计，每个文件最多 **5,000** tokens
- 排除 plan 文件和 claude.md 文件
- 跳过保留消息中已有的 Read 工具结果（避免重复注入）

### 5.2 其他附件恢复

- **Plan 附件**: 保留当前 plan 文件内容
- **Skill 附件**: 保留已调用的 skill 内容（每个最多 5K tokens，总计 25K budget）
- **Plan Mode 附件**: 保留 plan mode 状态指令
- **Async Agent 附件**: 保留后台运行/未检索的 agent 状态
- **工具延迟加载附件**: 通过 delta 机制重新声明工具 schema

### 5.3 消息链完整性

`buildPostCompactMessages()` 确保一致的顺序:

```
boundaryMarker → summaryMessages → messagesToKeep → attachments → hookResults
```

`annotateBoundaryWithPreservedSegment()` 在磁盘层面维护 UUID 链:

- `headUuid`: 保留段第一条消息
- `anchorUuid`: 锚点（`up_to` 方向为最后一条摘要，`from` 方向为 boundary 本身）
- `tailUuid`: 保留段最后一条消息

## 六、环境变量与配置

| 变量 | 作用 |
|------|------|
| `DISABLE_COMPACT` | 禁用所有压缩（自动+手动） |
| `DISABLE_AUTO_COMPACT` | 仅禁用自动压缩，保留手动 /compact |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 覆盖上下文窗口大小上限 |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 覆盖自动压缩触发百分比 |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | 覆盖阻塞阈值 |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | 覆盖模型上下文窗口 (仅限 Anthropic 内部) |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | 禁用 1M 上下文 |
| `ENABLE_CLAUDE_CODE_SM_COMPACT` | 强制启用 session memory 压缩 |
| `DISABLE_CLAUDE_CODE_SM_COMPACT` | 强制禁用 session memory 压缩 |

## 七、设计亮点与权衡

1. **多级缓存保护**: Cached micro-compact 通过 `cache_edit` API 在不破坏缓存前缀的前提下清除旧工具结果，避免每轮数千 tokens 的 cache_creation 开销

2. **熔断器模式**: 连续 3 次失败后停止自动压缩，防止无限循环消耗 API 配额

3. **并行工具调用的 token 估算**: `tokenCountWithEstimation()` 通过 `message.id` 回溯处理流式分片场景，避免严重低估上下文大小

4. **工具配对不变量**: `adjustIndexToPreserveAPIInvariants()` 确保 session memory 压缩不会切断 tool_use/tool_result 配对和跨分片的 thinking blocks

5. **摘要质量**: 通过 `<analysis>` 草稿区提升摘要质量，然后剥离；NO_TOOLS_PREAMBLE 防止模型在摘要时浪费唯一一次 turn 去调用工具

6. **Post-compact 恢复的 budget 控制**: 文件/技能附件都有严格的 token 预算限制，防止恢复操作本身占据过多上下文

## 八、Session Memory Compaction 深度剖析

要理解 Session Memory Compaction，需要先理解它由**两个独立子系统**组成，它们协同工作。

### 8.1 子系统 1: Session Memory（后台笔记提取）

这是一个**持续运行的后台任务**，与压缩无关。它的职责是维护一个 markdown 笔记文件，记录对话的关键信息。

#### 笔记文件结构

笔记文件存储在 `~/.claude/session-memory/` 下，有固定的模板结构 (`src/services/SessionMemory/prompts.ts`):

```markdown
# Session Title
_A short and distinctive 5-10 word descriptive title for the session._

# Current State
_What is actively being worked on right now? Pending tasks not yet completed._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order?_

# Errors & Corrections
_Errors encountered and how they were fixed. What approaches failed?_

# Codebase and System Documentation
_What are the important system components? How do they fit together?_

# Learnings
_What has worked well? What has not? What to avoid?_

# Key results
_If the user asked a specific output, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done?_
```

模板可自定义：放在 `~/.claude/session-memory/config/template.md`，更新 prompt 放在 `~/.claude/session-memory/config/prompt.md`。

#### 目录结构

Session Memory 文件按项目和会话隔离存储，路径由以下函数生成 (`src/utils/permissions/filesystem.ts:261-270`):

```typescript
getSessionMemoryDir()  → join(getProjectDir(getCwd()), getSessionId(), 'session-memory')
getSessionMemoryPath() → join(getSessionMemoryDir(), 'summary.md')
```

完整目录结构：

```
~/.claude/                                    ← Claude Code 配置根目录
├── projects/                                 ← 按项目隔离
│   └── -Users-wrr-myproject/                 ← 项目目录 (cwd 的 sanitized 形式)
│       ├── {session-id-1}/                   ← 每个 session 一个 UUID 目录
│       │   ├── transcript.json               ← 对话记录
│       │   └── session-memory/
│       │       └── summary.md                ← Session Memory 笔记文件
│       ├── {session-id-2}/
│       │   └── session-memory/
│       │       └── summary.md
│       └── ...
├── session-memory/                           ← 全局配置 (可选)
│   └── config/
│       ├── template.md                       ← 自定义模板 (覆盖默认模板)
│       └── prompt.md                         ← 自定义提取 prompt (支持 {{currentNotes}}, {{notesPath}})
└── ...
```

关键点：
- **按项目隔离**: 不同项目目录 (`cwd`) 的 session memory 互不影响
- **按会话隔离**: 每次启动 Claude Code 生成新的 session UUID，笔记文件独立
- **文件名固定**: 始终为 `summary.md`
- **自定义配置全局共享**: `~/.claude/session-memory/config/` 下的模板和 prompt 对所有项目生效

#### 工作方式

1. **注册时机**: `initSessionMemory()` (`sessionMemory.ts:357`) 在启动时注册一个 `postSamplingHook`（每次模型响应后都会触发的钩子），前提是 `isAutoCompactEnabled()` 为 true。

2. **提取触发条件** (`shouldExtractMemory()`, `sessionMemory.ts:134`):

   - **首次初始化**: 上下文增长到 `minimumMessageTokensToInit`（默认 10K tokens）
   - **后续更新**: 需要满足以下条件：
     - 上下文增长 >= `minimumTokensBetweenUpdate`（默认 5K tokens）
     - 并且满足以下任一：
       - 工具调用次数 >= `toolCallsBetweenUpdates`（默认 3 次）
       - 最后一个 assistant 消息没有工具调用（自然对话断点）

3. **提取执行** (`sessionMemory.ts:272-350`):

   ```
   extractSessionMemory (postSamplingHook)
       │
       ├─ 只在主线程运行 (querySource === 'repl_main_thread')
       │
       ├─ isSessionMemoryGateEnabled()? (feature flag: tengu_session_memory)
       │
       ├─ shouldExtractMemory(messages)?
       │   ├─ 是否已初始化? (上下文 >= 10K tokens)
       │   └─ 是否满足更新阈值? (增长 >= 5K tokens + 3次工具调用)
       │
       ├─ setupSessionMemoryFile()
       │   ├─ 创建目录和文件 (如果不存在)
       │   └─ 用 FileReadTool 读取当前笔记内容
       │
       ├─ buildSessionMemoryUpdatePrompt()
       │   ├─ 加载自定义或默认 prompt 模板
       │   ├─ 替换 {{currentNotes}} 和 {{notesPath}} 变量
       │   └─ 分析 section 大小，添加超限提醒
       │       ├─ 每个 section 限制: 2000 tokens
       │       └─ 总文件限制: 12000 tokens
       │
       ├─ runForkedAgent()
       │   ├─ querySource: 'session_memory'
       │   ├─ canUseTool: 只允许 Edit 笔记文件
       │   ├─ 继承主线程 prompt cache
       │   └─ 看到完整对话历史 + 当前笔记 → 更新笔记
       │
       ├─ recordExtractionTokenCount() (记录当前上下文大小)
       │
       └─ updateLastSummarizedMessageIdIfSafe()
           └─ 标记"笔记已覆盖到最后这条消息"
               (只在最后一个 assistant 消息没有工具调用时才标记，
                避免在工具调用中间截断，导致 tool_result 成为孤儿)
   ```

4. **关键状态** (`sessionMemoryUtils.ts`):

   - `lastSummarizedMessageId`: 笔记已经覆盖到哪条消息
   - `tokensAtLastExtraction`: 上次提取时的上下文大小（用于计算增量）
   - `sessionMemoryInitialized`: 是否已经做过首次提取
   - `extractionStartedAt`: 正在提取的时间戳（用于并发控制）

5. **并发控制**:

   - `sequential()` 包装确保同一时间只有一个提取在运行
   - `waitForSessionMemoryExtraction()` 让 SM Compact 等待正在进行的提取完成（最多 15 秒，超过 1 分钟视为过期）

#### 触发时机详解

提取在主查询循环中的精确位置 (`src/query.ts:1001-1008`):

```
query.ts 主循环
    │
    ├─ 1. 模型流式响应完成 (for await ... callModel)
    │
    ├─ 2. executePostSamplingHooks()     ← fire-and-forget (void, 不阻塞主流程)
    │   └─ extractSessionMemory()        ← 注册的 hook 之一
    │       ├─ querySource === 'repl_main_thread'?  (只主线程)
    │       ├─ isSessionMemoryGateEnabled()?         (feature flag)
    │       ├─ shouldExtractMemory(messages)?        (阈值判断 ↓ 见下表)
    │       └─ runForkedAgent()                     (后台运行, 不阻塞)
    │
    ├─ 3. abort 检查
    ├─ 4. 工具执行
    └─ 5. continuation 判断 (是否继续对话)
```

**`shouldExtractMemory()` 的阈值判断** (`sessionMemory.ts:134`):

```
currentTokenCount = tokenCountWithEstimation(messages)

首次提取:
  currentTokenCount >= 10,000 (minimumMessageTokensToInit) → 标记初始化, 继续判断更新条件

后续更新 (必须满足 token 增长, 再加以下任一):
  ├─ 路径A: 增长 >= 5,000 tokens  AND  工具调用 >= 3 次 (自上次提取以来)
  └─ 路径B: 增长 >= 5,000 tokens  AND  最后一个 assistant 消息没有工具调用
             (利用自然对话断点)
```

以一个典型编码会话为例：

| 轮次 | 上下文大小 | 自上次工具调用 | 提取? | 原因 |
|------|----------|--------------|------|------|
| 1-3 | 2K, 4K, 8K | 0, 1, 3 | 否 | 未达 10K 初始化阈值 |
| 4 | 12K | 5 | **是** | 首次 >= 10K 初始化; 增长 12K >= 5K + 工具 5 >= 3 |
| 5-6 | 16K, 19K | 6, 8 | 否 | 增长未达 5K (12K→16K=4K) |
| 7 | 24K | 11 | **是** | 增长 12K→24K = 12K >= 5K, 工具 11-5=6 >= 3 |
| 8 | 30K | 12 | 否 | 增长 24K→30K = 6K >= 5K, 但工具仅 1 < 3, 且最后 assistant 有工具调用 |
| 9 (用户说了句话) | 31K | 12 | **是** | 增长 >= 5K + 最后 assistant 无工具调用 (路径B) |

关键特性:
- **fire-and-forget**: `void executePostSamplingHooks(...)` 不阻塞主对话
- **串行保证**: `sequential()` 包装确保同一时间只有一个提取在跑
- **滞后更新**: 提取完成后才更新 `lastSummarizedMessageId`，所以 SM Compact 使用的可能是上一轮的笔记

#### 笔记文件完成态示例

初始状态是纯模板（只有 section header + 斜体描述行）。经过多次 forked agent Edit 后的完成态:

```markdown
# Session Title
Implement user authentication with JWT for REST API

# Current State
_What is actively being worked on right now? Pending tasks not yet completed._
Writing integration tests for the token refresh endpoint. The refresh logic
is implemented in src/services/auth.ts but tests are failing due to clock
mocking issues in the test environment.

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_
Build a complete JWT auth system: login, logout, token refresh, protected routes.
Design decisions:
- Access token: 15min TTL, stored in memory (not localStorage for XSS protection)
- Refresh token: 7d TTL, httpOnly cookie
- Use RS256 algorithm (asymmetric, public key can be shared with other services)

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_
- src/services/auth.ts - Core auth logic: generateTokenPair(), refreshAccessToken(), validateToken()
- src/middleware/auth.ts - Express middleware: requireAuth(), optionalAuth()
- src/routes/auth.ts - API endpoints: POST /login, POST /logout, POST /refresh
- src/models/User.ts - User model with password hash comparison
- src/__tests__/auth.test.ts - Integration tests (in progress)

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_
npm test -- --watch src/__tests__/auth.test.ts   # Run auth tests in watch mode
npm run dev                                        # Start dev server on :3001
npx prisma migrate dev                             # Run DB migrations

# Errors & Corrections
_Errors encountered and how they were fixed. What approaches failed and should not be tried again?_
- Token refresh race condition: Two concurrent requests both saw expired token
  and triggered refresh simultaneously, causing one to fail with 401.
  Fixed by adding mutex lock around refreshAccessToken().
- DO NOT use jest.useFakeTimers() with date-fns — causes infinite loop in
  interval calculations. Use manual Date mocking instead.
- User explicitly said NOT to store tokens in localStorage (XSS concern).

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_
Express app → auth middleware (requireAuth) → checks Authorization header →
validates JWT with RS256 public key → attaches req.user. Token refresh handled
by dedicated /refresh endpoint that validates httpOnly cookie refresh token.

# Learnings
_What has worked well? What has not? What to avoid?_
- RS256 was the right choice — public key can be shared with the API gateway
- Prisma's built-in bcrypt via @prisma/client/extension works well for hashing

# Key results
_If the user asked a specific output, repeat the exact result here_
(暂无)

# Worklog
_Step by step, what was attempted, done?_
1. Set up auth routes and middleware skeleton
2. Implemented generateTokenPair() with RS256
3. Built login/logout endpoints
4. Added refresh token logic with httpOnly cookie
5. Discovered and fixed race condition in refreshAccessToken()
6. Started integration tests — currently debugging clock mocking
```

内容约束:
- 每个 section 不超过 **2,000 tokens**（超出时 forked agent 收到压缩提醒）
- 整个文件不超过 **12,000 tokens**（超出时收到强制压缩指令）
- section header 和斜体描述行**永远不能被修改或删除**
- 自定义 prompt 支持 `{{currentNotes}}` 和 `{{notesPath}}` 变量替换

### 8.2 子系统 2: Session Memory Compact（用笔记文件替代传统压缩）

当 auto-compact 触发时，它**优先尝试**用 session memory 做压缩，而不是调用 API 做摘要。

#### 完整流程 (`trySessionMemoryCompaction()`, `sessionMemoryCompact.ts:514`)

```
auto-compact 触发
    │
    ├─ 1. shouldUseSessionMemoryCompaction()
    │     检查 feature flags: tengu_session_memory + tengu_sm_compact
    │     未启用 → 返回 null → 降级到传统 full compact
    │
    ├─ 2. initSessionMemoryCompactConfig()
    │     从 GrowthBook 加载远程配置（只加载一次）
    │     配置项: minTokens(10K), minTextBlockMessages(5), maxTokens(40K)
    │
    ├─ 3. waitForSessionMemoryExtraction()
    │     等待正在进行的后台笔记提取完成
    │     (最多等15秒，超过1分钟的提取视为过期直接跳过)
    │
    ├─ 4. 读取笔记文件内容
    │     ├─ 文件不存在 → 返回 null
    │     └─ 内容 == 空模板 → 返回 null (后台提取从未真正执行过)
    │
    ├─ 5. 确定 lastSummarizedMessageId 在消息数组中的位置
    │     这是"笔记已经覆盖到哪里"的标记：
    │     - 位置之前的消息 = 已经被笔记覆盖
    │     - 位置之后的消息 = 还没被笔记覆盖，必须保留
    │     找不到时降级到传统压缩
    │
    ├─ 6. calculateMessagesToKeepIndex(messages, lastSummarizedIndex)
    │     从 lastSummarizedIndex+1 开始向尾部扩展
    │     直到满足最低要求:
    │       - 保留段 >= minTokens (10K tokens)
    │       - 保留段 >= minTextBlockMessages (5 条文本消息)
    │     但不超过 maxTokens (40K tokens)
    │     不会跨过最后一个 compact boundary（防止磁盘链断裂）
    │
    ├─ 7. adjustIndexToPreserveAPIInvariants()
    │     回溯调整起始位置，确保:
    │       - tool_use 和对应的 tool_result 不被切断
    │       - 同一 message.id 的 thinking blocks 不被切断
    │       - 处理流式分片场景下的跨消息关联
    │
    ├─ 8. 构建 CompactionResult:
    │     ├─ boundaryMarker (压缩边界标记)
    │     ├─ summaryMessages (笔记内容包装成摘要消息)
    │     ├─ messagesToKeep (保留的原始消息，一字不改)
    │     └─ attachments (plan 附件等)
    │
    └─ 9. 检查压缩后的大小是否仍超过 autoCompactThreshold
          ├─ 超过 → 返回 null → 降级到传统 full compact
          └─ 未超过 → 返回 CompactionResult → 压缩完成
```

#### 确定保留消息的算法 (`calculateMessagesToKeepIndex`)

```
消息数组: [m0, m1, m2, ..., m20, m21, ..., m30]
                               ↑ lastSummarizedIndex=20

Step 1: startIndex = 21 (lastSummarizedIndex + 1)

Step 2: 从 startIndex=21 开始向尾部统计:
        totalTokens = sum(tokens of m21..m30)
        textBlockCount = count(messages with text blocks in m21..m30)

Step 3: 检查是否已满足最低要求:
        totalTokens >= 10K AND textBlockCount >= 5?
        ├─ 是 → return adjustIndex(startIndex)
        └─ 否 → 继续扩展

Step 4: 从 startIndex 向前扩展 (i = 20, 19, 18...)
        但不能跨过最后一个 compact boundary (floor)
        每扩展一条: totalTokens += msgTokens, textBlockCount++
        直到满足两个最低要求 或 达到 maxTokens(40K)

Step 5: adjustIndexToPreserveAPIInvariants()
        向前回溯确保 tool_use/tool_result 配对和 thinking blocks 完整
```

### 8.3 与传统 Full Compact 的对比

**传统 Full Compact**:

```
压缩前: [消息A, 消息B, 消息C, 消息D, 消息E, 消息F, 消息G]
                                                    ↑ 触发阈值

压缩后: [boundary, summary(A~E全部的AI摘要), 消息F, 消息G]
```

- 所有旧消息被一条 AI 生成的摘要替代
- 摘要质量取决于模型，可能丢失关键细节
- 需要一次额外的 API 调用来生成摘要
- 用户的原始对话文本完全丢失

**Session Memory Compact**:

```
压缩前: [消息A, 消息B, 消息C, 消息D, 消息E, 消息F, 消息G]
                                                    ↑ 触发阈值
                              ↑ lastSummarizedMessageId
                              (笔记已覆盖到这里)

压缩后: [boundary, 笔记文件内容, 消息D, 消息E, 消息F, 消息G]
                              ↑ 原始消息保留，一字不改
```

关键区别：

1. **不需要额外 API 调用** — 笔记文件已经由后台 agent 持续维护好了
2. **保留更多原始消息** — 只有被笔记覆盖的消息才被替换，笔记覆盖不到的原始消息原封不动保留
3. **笔记是结构化的** — 固定的 section 结构（Title, Current State, Files, Errors...）比自由格式的 AI 摘要更容易被模型利用
4. **渐进式更新** — 笔记是逐步更新的（每 5K tokens / 3 次工具调用一次），不是一次性从零生成

### 8.4 具体示例

假设你正在进行一个调试会话：

```
消息1-20:  你描述了 bug，读了多个文件，做了 grep 搜索
消息21-25: 你定位到问题，尝试修复
消息26-30: 修复验证，写测试
```

在消息20左右，后台 session memory 第一次触发提取，笔记文件被写入：

```markdown
# Session Title
Debug auth token expiry race condition

# Current State
Reading auth middleware code, tracing token refresh flow

# Files and Functions
- src/middleware/auth.ts - token validation logic
- src/services/token.ts - refresh token logic, refreshIfExpired()

# Errors & Corrections
(暂无)
```

在消息28左右，上下文接近阈值，auto-compact 触发。

**传统 Full Compact 会做**: 调用 API 把消息1-28全部摘要成一段文字，只保留29-30。

**Session Memory Compact 会做**:

1. 发现 `lastSummarizedMessageId` 在消息20附近
2. 从消息21开始向后扩展，保留21-30（原始消息，一字不改）
3. 用笔记文件作为消息1-20的替代
4. 结果：笔记文件 + 消息21-30（原始文本）

后者明显更好，因为消息21-30（定位问题、修复、验证）这些最关键的操作细节被完整保留了。

### 8.5 相关配置

| 配置项 | 默认值 | 来源 | 说明 |
|-------|-------|------|------|
| `minimumMessageTokensToInit` | 10,000 | GrowthBook `tengu_sm_config` | 首次触发笔记提取的最低上下文大小 |
| `minimumTokensBetweenUpdate` | 5,000 | GrowthBook `tengu_sm_config` | 两次笔记更新之间的最低上下文增量 |
| `toolCallsBetweenUpdates` | 3 | GrowthBook `tengu_sm_config` | 两次笔记更新之间的最低工具调用次数 |
| `minTokens` (SM Compact) | 10,000 | GrowthBook `tengu_sm_compact_config` | 压缩后保留消息的最小 token 数 |
| `minTextBlockMessages` | 5 | GrowthBook `tengu_sm_compact_config` | 保留消息中最少含文本块的消息数 |
| `maxTokens` (SM Compact) | 40,000 | GrowthBook `tengu_sm_compact_config` | 保留消息的 token 硬上限 |
| 每个 section 上限 | 2,000 tokens | 代码常量 `MAX_SECTION_LENGTH` | 笔记文件每个章节的 token 限制 |
| 笔记文件总上限 | 12,000 tokens | 代码常量 `MAX_TOTAL_SESSION_MEMORY_TOKENS` | 整个笔记文件的 token 限制 |

### 8.6 Session Memory 相关文件索引

| 文件路径 | 职责 |
|---------|------|
| `src/services/SessionMemory/sessionMemory.ts` | 后台笔记提取主逻辑、hook 注册、提取触发判断 |
| `src/services/SessionMemory/prompts.ts` | 笔记模板、更新 prompt、section 大小分析和截断 |
| `src/services/SessionMemory/sessionMemoryUtils.ts` | 配置管理、状态追踪、并发控制、笔记文件读写 |
| `src/services/compact/sessionMemoryCompact.ts` | 基于笔记文件的压缩逻辑、保留消息计算、API 不变量调整 |

## 九、核心文件索引

| 文件路径 | 职责 |
|---------|------|
| `src/services/compact/compact.ts` | 全量压缩与部分压缩主逻辑 |
| `src/services/compact/autoCompact.ts` | 自动压缩触发判断、阈值计算、熔断器 |
| `src/services/compact/microCompact.ts` | 轻量级工具结果清除（时间触发 + 缓存编辑） |
| `src/services/compact/sessionMemoryCompact.ts` | 基于 session memory 的无损压缩 |
| `src/services/compact/prompt.ts` | 压缩 prompt 模板、摘要格式化 |
| `src/utils/context.ts` | 上下文窗口大小、模型能力查询 |
| `src/utils/tokens.ts` | Token 计算（规范函数 `tokenCountWithEstimation`） |
| `src/utils/analyzeContext.ts` | 上下文使用量按类别分析 |
| `src/services/api/promptCacheBreakDetection.ts` | 缓存失效检测与误报抑制 |
