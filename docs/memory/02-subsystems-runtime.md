# 分册 02：子系统与运行时（源码深拆 + 逐函数）

> **节选来源**：[claude-code-memory-system-deep-analysis.md](./claude-code-memory-system-deep-analysis.md)  
> **分析源码树**：`D:\work\claude-code-source`  
> **本册对应合订本章节**：二十一～三十（源码级拆解与设计表）、三十七～四十五（逐函数剖析与速览）。

### 与源码直接对应的入口文件（速查）

| 主题 | 路径（相对源码根 `src/`） |
|------|---------------------------|
| AutoMemory 开关与路径 | `memdir/paths.ts`（`isAutoMemoryEnabled`、`getAutoMemPath`、`validateMemoryPath`） |
| Memdir 提示词 / KAIROS | `memdir/memdir.ts`（`loadMemoryPrompt`、`truncateEntrypointContent`） |
| 指令记忆 | `utils/claudemd.ts` |
| 相关记忆 | `memdir/findRelevantMemories.ts`、`memdir/memoryScan.ts`、`utils/attachments.ts` |
| 回合后抽取 | `services/extractMemories/extractMemories.ts`、`services/extractMemories/prompts.ts` |
| Session 与 Compact | `services/SessionMemory/`、`services/compact/sessionMemoryCompact.ts` |
| 团队同步 | `services/teamMemorySync/`、`memdir/teamMemPaths.ts` |

**调用方提示**：主系统提示词在 `constants/prompts.ts` 中通过 `loadMemoryPrompt()` 挂载 memory 段（与 `isAutoMemoryEnabled` 等在运行时的 gate 组合使用）。

---

## 二十一、源码级深度拆解（一）：`memdir/paths.ts` 的“开关-路径-安全”三联体

这一章不再做概念描述，而是按函数拆代码行为。你可以把 `paths.ts` 视为记忆系统“地基层”，上层几乎全部依赖这里的输出正确性。

### 21.1 `isAutoMemoryEnabled()`：策略判定函数的短路设计

#### 输入来源

- `process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY`
- `process.env.CLAUDE_CODE_SIMPLE`
- `process.env.CLAUDE_CODE_REMOTE`
- `process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR`
- `getInitialSettings().autoMemoryEnabled`

#### 执行语义（按优先级短路）

1. 如果 env 显式 truthy 禁用，立即返回 false；
2. 如果 env 显式 falsy，立即返回 true；
3. 若 SIMPLE 模式，返回 false；
4. 若远程模式但没持久目录，返回 false；
5. 若 settings 指定，返回其值；
6. 默认 true。

#### 为什么这样写

- 这是“**显式配置优先**”策略，避免模块内部默认值影响用户意图。
- 同时避免“延迟读取配置”导致执行阶段路径先用后改的竞态。

#### 隐含工程收益

- 所有调用者都可把它当纯函数门槛，减少重复判断。
- 便于测试：只要设置环境变量和 settings mock，即可覆盖主要分支。

---

### 21.2 `validateMemoryPath(raw, expandTilde)`：路径防护的第一道关卡

#### 关键防护点

- 非绝对路径拒绝；
- near-root 拒绝（防止把根目录当 memory root）；
- Windows 盘符根拒绝；
- UNC 路径拒绝；
- null byte 拒绝；
- `~/` 仅在可控场景展开，且拒绝展开到 home 本身或祖先目录。

#### 设计细节

函数会先 `normalize` 再 strip 尾分隔符，再统一追加一个分隔符。  
这保证后续 `startsWith(memoryDir)` 判定时语义一致，减少边界字符串误判。

#### 方法论点评

这属于“**先规范化、再比较**”模式。任何路径判定如果跳过规范化，基本都会留下绕过空间。

---

### 21.3 `getAutoMemPath()`：项目域命名与可迁移性

#### 解析顺序

1. env override；
2. settings override；
3. 默认 `<memoryBase>/projects/<sanitizePath(getAutoMemBase())>/memory/`

其中 `getAutoMemBase()` 优先 canonical git root。这意味着：

- 同仓库不同 worktree 可共享 AutoMem；
- 减少“同一项目多份记忆”碎片化。

#### 风险与收益

- 收益：跨 worktree 一致性；
- 风险：极少数场景下用户希望 worktree 隔离记忆，但默认策略不会隔离。

这就是典型“全局一致性优先于局部隔离”的选择。

---

### 21.4 `isAutoMemPath(absolutePath)`：权限判断的关键前置

实现是 normalize 后做前缀匹配。注意：  
它本身不是完整安全校验（TeamMem 还要 realpath 深校验），但它是大量模块的快速路径判断基础。

---

## 二十二、源码级深度拆解（二）：`memdir/memdir.ts` 的 prompt 编排引擎

### 22.1 `truncateEntrypointContent(raw)`：双阈值截断算法逐步执行

#### 输入

- 原始 `MEMORY.md` 文本。

#### 中间变量

- `lineCount`：总行数；
- `byteCount`：原始字符长度（实现中按字符串长度近似字节）；
- `wasLineTruncated` / `wasByteTruncated`。

#### 处理步骤

1. 先按行截断到 `MAX_ENTRYPOINT_LINES`；
2. 若截断结果仍超字节阈值，回退到阈值前最后一个 `\n`；
3. 构造 warning，说明超限原因；
4. 返回结构体（content + 计数 + 标记）。

#### 为什么先行后字节

- 行是自然语义边界，先行截断可最大限度保留结构；
- 字节截断只做兜底，主要防长行异常。

---

### 22.2 `buildMemoryLines(...)`：行为约束模板生成器

它本质上不是“文案拼接”，而是“代理行为协议生成器”。  
该函数把以下协议编码进系统 prompt：

1. 分类法（四类记忆）；
2. 明确排除项（不能存什么）；
3. 存储流程（topic 文件 + MEMORY.md 索引）；
4. 读取时机（何时必须读 memory）；
5. 漂移验证（记忆不等于当前事实）。

#### `skipIndex` 分支

- `skipIndex = true` 时，提示词弱化或移除索引维护要求。
- 用于特定实验/feature gate 场景，降低索引维护开销。

---

### 22.3 `loadMemoryPrompt()`：策略路由器的完整分支图

可抽象为：

```
if auto disabled -> null
else if KAIROS active -> assistant daily log prompt
else if TEAMMEM enabled -> combined prompt
else -> auto-only prompt
```

但真实实现更细：

- KAIROS 优先级高于 TEAMMEM（两种范式不兼容）；
- TEAMMEM 分支里只创建 teamDir（因为 team 在 auto 下，递归 mkdir 可同时创建父路径）；
- 所有分支都埋点 `logMemoryDirCounts`。

#### 关键设计思想

这是把策略放在单一入口函数中，避免多模块各自判断导致行为分裂。

---

## 二十三、源码级深度拆解（三）：`utils/claudemd.ts` 的指令记忆装载机制

### 23.1 `getMemoryFiles()` 的执行相位

该函数一次调用包含多个相位：

1. 加载 managed/user 指令；
2. 自下而上收集 project/local 指令；
3. 处理 `.claude/rules`；
4. 加载 AutoMem/TeamMem entrypoint；
5. 统计与 hook 上报。

#### 重点：不是简单读固定路径

- 它会沿 cwd 到 root 逐层扫描；
- 会考虑 worktree 与 canonical repo 的双路径关系，避免重复加载；
- 会处理 includes、外部 include 审批、exclude pattern、symlink 情况。

---

### 23.2 `processMemoryFile(...)`：递归 include 处理器

#### 参数语义

- `processedPaths`：去重与防循环；
- `includeExternal`：是否允许引入工作目录外文件；
- `depth`：限制最大 include 深度；
- `parent`：记录包含链来源。

#### 核心流程

1. 路径归一化后去重；
2. 读取文件并解析 frontmatter；
3. 解析 include 路径；
4. 对 include 递归调用；
5. 返回主文件 + 子 include 文件列表。

#### 安全点

- 非文本扩展直接跳过；
- include 最大深度限制；
- 外部路径默认不放行（除非审批/配置允许）。

---

### 23.3 `getClaudeMds(...)`：上下文拼接的优先级表达

这个函数把 `MemoryFileInfo[]` 转为最终 prompt 文本。  
它不是简单 join，而是对不同类型添加不同语义标签，例如：

- Project：强调“仓库内规则”
- Local：强调“私有本地规则”
- AutoMem：强调“跨会话自动记忆”
- TeamMem：强调“团队共享记忆”

这些标签会影响模型对内容权重的理解。

---

## 二十四、源码级深度拆解（四）：Relevant Retrieval 全链路

### 24.1 `scanMemoryFiles(memoryDir, signal)` 的文件头扫描策略

#### 为什么只读头部

记忆相关性判定主要依赖 frontmatter `description/type`，没必要读全正文。  
通过 `readFileInRange` 只读前 `FRONTMATTER_MAX_LINES`，可显著降低 I/O。

#### 错误处理策略

实现用了 `Promise.allSettled`：

- 单文件失败不会导致整批失败；
- 失败文件被过滤，整体召回继续执行。

这是“召回链路弱依赖”设计，优先可用性。

---

### 24.2 `findRelevantMemories(...)` 的两阶段过滤

#### 阶段一：候选前过滤

- 移除 `alreadySurfaced` 路径，避免重复消费预算。

#### 阶段二：模型选择后过滤

- 只保留 filename 在候选集内的返回值（防 hallucinated filename）；
- 输出绝对路径 + mtime。

这是一种“先给模型语义自由，再做严格白名单收敛”的模式。

---

### 24.3 `startRelevantMemoryPrefetch(...)` 的生命周期绑定

#### 输入截断条件

- AutoMemory 未启用 -> 跳过；
- feature gate 关闭 -> 跳过；
- 无有效 user message -> 跳过；
- 输入是单词 -> 跳过；
- 已达会话注入 bytes 上限 -> 跳过。

#### 运行时行为

- 创建 child abort controller；
- 启动异步 promise；
- `Symbol.dispose` 时 abort，并记录 prefetch telemetry。

这使 prefetch 生命周期与 query 循环绑定，避免悬挂任务。

---

### 24.4 `filterDuplicateMemoryAttachments(...)` 的“先过滤后标记”

旧设计容易出现：预取时提前写入 `readFileState`，导致后续过滤把自己全过滤掉。  
当前实现先过滤，再把保留项写入 `readFileState`，避免自我抑制循环。

这类 bug 属于状态交互顺序错误，修复点在“副作用时机”而非算法本身。

---

## 二十五、源码级深度拆解（五）：`extractMemories.ts` 状态机与并发收敛

### 25.1 初始化：为何用 `initExtractMemories()`

该模块不是导出一组纯函数，而是通过 init 创建闭包状态。原因：

- 测试场景需要每 case 独立状态；
- 运行时需要跨回合持有游标与 in-flight 集合；
- 避免进程级全局状态污染。

---

### 25.2 `hasMemoryWritesSince(...)`：互斥策略的关键判定器

它扫描 `assistant.message.content` 中 tool_use block：

- 只关心 Edit/Write；
- 提取 `file_path`；
- `isAutoMemPath(file_path)` 为真则判定“主链已写记忆”。

#### 重要含义

这是“行为互斥”的实现锚点。没有它，主写和抽取器会竞争更新。

---

### 25.3 `createAutoMemCanUseTool(memoryDir)`：后台能力白名单

#### 允许集合

- Read/Grep/Glob：完全放行（只读）；
- Bash：仅当 `tool.isReadOnly(parsed.data)`；
- Edit/Write：仅 file_path 在 memoryDir 内。

#### REPL 特例

REPL 自身允许，但其内部 primitive 调用会再次过同一 canUseTool，保证最终边界不失效。

---

### 25.4 `runExtraction(...)` 的核心流程（逐步）

1. 计算新消息数（相对游标）；
2. 若主链已写 memory -> skip + 推进游标；
3. 节流判定（每 N eligible turns）；
4. 扫描 memory files 构建现有 manifest；
5. 构建 extraction prompt（auto-only 或 combined）；
6. `runForkedAgent()` 执行，maxTurns=5；
7. 提取写入路径、统计 usage、发事件；
8. 若写入了 topic 文件，append system memory-saved 消息；
9. finally 内处理 trailing pendingContext。

---

### 25.5 并发语义：为什么只保留最新 pendingContext

当 inProgress=true 时，新的请求不排队，而是覆盖 `pendingContext`。  
设计意图：

- 旧上下文在新上下文里已被包含；
- 排队会拖慢并浪费抽取；
- 最后一次状态最有价值。

这是“增量可覆盖”的任务模型，与日志处理模型不同。

---

## 二十六、源码级深度拆解（六）：SessionMemory 与 SessionMemoryCompact

### 26.1 `shouldExtractMemory(messages)`：双阈值 + 边界条件

该函数不只看 token，也看工具调用与最后一轮是否还有 tool_use：

- 必须先达到初始化阈值；
- 更新要满足 token 增量阈值；
- 还要满足 tool call 条件或回合自然断点；
- 满足后更新 `lastMemoryMessageUuid`。

这保证 session memory 更新频率可控且尽量在“语义段落完成处”触发。

---

### 26.2 `setupSessionMemoryFile(...)`：文件准备与 read cache 协调

流程：

1. mkdir 会话目录（700）；
2. 若文件不存在，创建并写模板（600）；
3. 清除 `toolUseContext.readFileState` 该路径缓存；
4. 调 FileReadTool 读取真实内容（防止 dedup 返回 file_unchanged stub）。

这个细节很重要：如果不清 cache，后续编辑提示会拿不到真实内容。

---

### 26.3 `createMemoryFileCanUseTool(memoryPath)`：极限收敛权限

只允许：

- 工具名 = FileEdit；
- 且 `file_path === memoryPath`。

任何偏离都 deny。  
这让 session 子代理几乎不可能越权到仓库代码。

---

### 26.4 `sessionMemoryCompact.ts` 的不变量修复算法（细化）

`adjustIndexToPreserveAPIInvariants(messages, startIndex)` 分两步：

1. **tool_use/tool_result 对齐**
   - 收集保留区 tool_result IDs；
   - 检查保留区是否已有对应 tool_use；
   - 若缺失，向前回溯并前移 startIndex。

2. **message.id 同族分片对齐**
   - 收集保留区 assistant message.id；
   - 向前找同 message.id 的前序分片（常是 thinking）；
   - 找到则继续前移 startIndex。

这避免了 compact 后出现“结果有了，调用没了”或“思维块丢失”。

---

### 26.5 `trySessionMemoryCompaction(...)` 的决策树

1. gate 不通过 -> null；
2. 等待 in-progress extraction 结束（软超时）；
3. 无 session memory 文件 -> null；
4. session memory 仅模板空内容 -> null；
5. 找 `lastSummarizedMessageId`：
   - 找不到且非恢复场景 -> null；
   - 恢复场景按 messages.length - 1 处理；
6. 计算 startIndex；
7. 过滤旧 compact boundary；
8. 组装 compaction result；
9. 若 postCompactTokenCount 仍超阈值 -> null；
10. 否则返回新 compact 结果。

这是一种“能用就用，不能用就无害回退”的稳健策略。

---

## 二十七、源码级深度拆解（七）：Team Memory Sync 协议实现

### 27.1 `SyncState` 的协议角色

可以把 `SyncState` 看成简化版客户端副本元数据：

- `lastKnownChecksum`：副本版本；
- `serverChecksums`：每 key 内容摘要；
- `serverMaxEntries`：服务端约束缓存。

所有 pull/push 都依赖这三者协同，不是无状态调用。

---

### 27.2 `pullTeamMemory(...)`：服务端到本地的幂等覆盖

步骤：

1. OAuth 与 repo slug 校验；
2. 带可选 ETag 拉取；
3. 304 -> notModified；
4. 404 -> 远端空数据，清空 serverChecksums；
5. 解析响应并刷新 `state.serverChecksums`；
6. `writeRemoteEntriesToLocal`（仅内容变化文件写盘）；
7. 若写盘>0，清理 `getMemoryFiles` 缓存。

注意点：写盘前做路径校验与大小限制，防止污染本地。

---

### 27.3 `pushTeamMemory(...)`：delta 上传 + 412 收敛

步骤：

1. 读取本地 entries（含 secret scan）；
2. 预计算 localHashes；
3. 构建 delta（localHash != serverHash）；
4. delta 为空直接成功；
5. `batchDeltaByBytes` 分批；
6. 逐批 upload，成功批次即时更新 serverChecksums；
7. 若失败且非 conflict，按错误返回；
8. 若 412 conflict：
   - 调 `fetchTeamMemoryHashes`；
   - 刷新 serverChecksums；
   - 回到步骤 3 重算 delta。

#### 收敛性解释

只要冲突不是无限新写入，重算 delta 会不断缩小上传集，最终收敛到成功或无增量。

---

### 27.4 `batchDeltaByBytes(...)`：为什么按字节而不是按文件数

网关 413 触发由请求体字节决定，不是文件数。  
按字节切批可以：

- 更稳定规避网关限制；
- 保证单批成功率；
- 支持大文件独立批次。

这是“以真实瓶颈为切分维度”的实现思路。

---

### 27.5 watcher 的故障抑制机制

`watcher.ts` 增加 `pushSuppressedReason`，用于永久性失败后停止自动重试。  
否则在无 OAuth 或无 repo 场景下会形成日志与网络风暴。

该机制本质是“失败熔断”，并保留 unlink 恢复路径。

---

## 二十八、从实现到方法论：可复用的系统设计原则

把上述源码抽象后，可提炼出可复用的 10 条原则：

1. **单一策略入口**：所有开关分支在少数总函数中决策（如 `loadMemoryPrompt`）；
2. **信息分层存储**：索引与正文分离，长期与会话分离；
3. **按需注入而非常驻全量**：以相关召回替代盲目扩容 prompt；
4. **后台任务最小权限**：限制工具与路径，杜绝越权；
5. **互斥与去重先于智能化**：先保证不重复写，再追求提取质量；
6. **并发可合并**：高频事件只保留最新上下文，避免队列爆炸；
7. **协议不变量前置**：compact 先保证 API 配对，再谈摘要质量；
8. **同步基于内容寻址**：hash delta 是协作系统可扩展基础；
9. **失败显式分型与熔断**：区分可重试与不可重试，避免风暴；
10. **可观测性内建**：每个关键分支都有 telemetry，对线上行为可解释。

---

## 二十九、可直接用于评审的“函数-风险-验证”表

### 29.1 `memdir/paths.ts`

- 核心函数：`isAutoMemoryEnabled`, `getAutoMemPath`, `validateMemoryPath`
- 主要风险：路径覆盖导致越权写目录
- 验证重点：
  - env + settings 优先级回归
  - `~/` 边界展开
  - root/UNC/null-byte 拒绝

### 29.2 `findRelevantMemories.ts` + `attachments.ts`

- 核心函数：`scanMemoryFiles`, `selectRelevantMemories`, `startRelevantMemoryPrefetch`
- 主要风险：误召回噪声、重复注入、预取状态污染
- 验证重点：
  - alreadySurfaced + readFileState 去重
  - prefetch 取消与释放
  - 单词输入短路

### 29.3 `extractMemories.ts`

- 核心函数：`hasMemoryWritesSince`, `runExtraction`, `createAutoMemCanUseTool`
- 主要风险：主写冲突、后台越权、并发重入
- 验证重点：
  - 主写后是否必 skip
  - pendingContext trailing 行为
  - canUseTool 拒绝边界

### 29.4 `sessionMemoryCompact.ts`

- 核心函数：`adjustIndexToPreserveAPIInvariants`, `calculateMessagesToKeepIndex`
- 主要风险：compact 后 API 参数不合法
- 验证重点：
  - tool_use/tool_result 成对保留
  - 同 message.id 分片合并

### 29.5 `teamMemorySync/index.ts`

- 核心函数：`pullTeamMemory`, `pushTeamMemory`, `batchDeltaByBytes`
- 主要风险：冲突不收敛、413、secret 外泄
- 验证重点：
  - 412 重试收敛
  - body 切批边界
  - secret scan 跳过与告警

---

## 三十、结论补充：为什么这份实现“不是点到为止”

如果只看表层，你会觉得它是“几个 markdown 文件 + 一点 prompt 拼接”。  
但源码级分析显示，这个系统实际上解决的是四类基础设施问题：

1. **知识生命周期管理**（产生、存储、召回、淘汰）；
2. **多代理并发一致性**（主链与后台链互斥 + 合并）；
3. **上下文资源调度**（固定预算下注入最大价值）；
4. **协作同步协议**（内容寻址 + 冲突收敛 + 安全防线）。

因此，Claude Code 记忆系统本质上是一个“小型知识基础设施”，而不是单个功能点。  
你如果要继续深挖下一层，建议直接做两件事：

- 画出 `query-time + post-turn + compact-time` 三套时序图（已可从本文函数链直接生成）；
- 为每条关键函数补“失败注入测试”（fault injection），验证回退路径与不变量。

---

## 三十一、形式化论证（一）：TeamMemory 412 冲突重试为什么可收敛

## 三十七、逐函数实现剖析（A）：`src/memdir/paths.ts`

> 本章按函数给出“实现了什么、怎么实现、为什么这样实现”。  
> 记号说明：  
> - **职责**：函数对系统的功能贡献；  
> - **输入/输出**：含隐式输入（env/settings/global state）；  
> - **算法步骤**：按代码执行顺序展开；  
> - **关键分支**：影响行为的 if/early return；  
> - **副作用**：缓存、日志、外部状态变化；  
> - **边界与风险**：函数的已知假设与潜在误用点。

### 37.1 `isAutoMemoryEnabled(): boolean`

**职责**  
判定 AutoMemory 总开关，是几乎所有 memory 子系统的第一门槛。

**输入（隐式）**
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY`
- `CLAUDE_CODE_SIMPLE`
- `CLAUDE_CODE_REMOTE`
- `CLAUDE_CODE_REMOTE_MEMORY_DIR`
- `getInitialSettings().autoMemoryEnabled`

**输出**
- `true/false`

**算法步骤**
1. 读取禁用 env；
2. 若 env truthy -> `false`；
3. 若 env defined falsy -> `true`；
4. 若 SIMPLE -> `false`；
5. 若 remote 且无 memory dir -> `false`；
6. 若 settings 明确给值 -> 使用 settings；
7. 否则默认 `true`。

**关键分支意义**
- 先 env 再 settings，体现“外部显式配置优先于持久配置”。
- SIMPLE 分支确保 bare 模式不会悄悄开启后台记忆能力。

**副作用**
- 无（纯判定）。

**边界与风险**
- 若调用者缓存结果过久，运行时 env 变化不会反映；但该系统默认 env/session 稳定。

---

### 37.2 `isExtractModeActive(): boolean`

**职责**  
判定“是否允许执行回合后记忆抽取（extractMemories）”。

**输入**
- GB gate: `tengu_passport_quail`
- 是否非交互会话
- GB gate: `tengu_slate_thimble`（允许非交互也执行）

**输出**
- `true/false`

**算法**
1. gate 未开直接 false；
2. 交互会话返回 true；
3. 非交互会话仅当第二 gate 开启时 true。

**设计原因**
- 抽取是后台增值能力，不应在所有模式默认运行。

---

### 37.3 `getMemoryBaseDir(): string`

**职责**  
返回 memory 根目录（用于 AutoMemory、AgentMemory 等）。

**算法**
1. 若 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 存在，直接用它；
2. 否则使用 `getClaudeConfigHomeDir()`（通常 `~/.claude`）。

**边界**
- 假设该路径可读写；真正写入失败在上层处理。

---

### 37.4 `validateMemoryPath(raw, expandTilde): string | undefined`

**职责**  
对用户/环境提供的 memory 路径做安全规范化。

**实现步骤**
1. 空值直接 `undefined`；
2. 可选处理 `~/` 展开；
3. reject 展开后指向 home 根或上级（`.`/`..`）；
4. `normalize` + strip 尾分隔符；
5. reject 非绝对、长度过短、盘符根、UNC、null byte；
6. 返回 `normalized + sep`（统一尾分隔符）并 NFC 归一化。

**关键点**
- 统一尾分隔符是为了后续 `startsWith` 判定不出错。

**安全语义**
- 这是“防错误配置”+“防路径投毒”的双重校验。

---

### 37.5 `getAutoMemPathOverride()` / `getAutoMemPathSetting()`

**职责**
- `getAutoMemPathOverride`：读取 env 级绝对覆盖；
- `getAutoMemPathSetting`：读取 settings 覆盖（受信来源限定）。

**差异**
- env 覆盖不做 `~` 展开（假设程序化传值）；
- settings 覆盖支持 `~`（提升手工配置体验）。

---

### 37.6 `hasAutoMemPathOverride(): boolean`

**职责**  
告诉上层“是否处于外部显式 memory path 接管模式”。

**为什么有这个函数**
- 某些写权限 carve-out 逻辑需要区分“用户自己配置”与“SDK 强制接管”。

---

### 37.7 `getAutoMemPath`（memoized const）

**职责**  
返回 AutoMemory 目录绝对路径（最终值）。

**实现要点**
1. 优先 override（env > settings）；
2. 否则拼接 `<memoryBase>/projects/<sanitize(getAutoMemBase)>/memory/`；
3. 使用 memoize 缓存，key 为 `getProjectRoot()`。

**为何 memoize**
- 该函数会在 UI/render 路径高频调用，减少 repeated settings parse/realpath 开销。

**边界**
- 运行时动态改变 env/settings 在同 session 内不一定即时生效（这是有意 tradeoff）。

---

### 37.8 `getAutoMemDailyLogPath(date?)`

**职责**  
KAIROS 模式下返回当日日志文件路径：`logs/YYYY/MM/YYYY-MM-DD.md`。

**实现**
- 纯日期格式化 + 路径 join。

---

### 37.9 `getAutoMemEntrypoint()`

**职责**  
返回 `getAutoMemPath()/MEMORY.md`。

---

### 37.10 `isAutoMemPath(absolutePath)`

**职责**  
快速判定某绝对路径是否在 AutoMemory 子树中。

**算法**
1. normalize 输入；
2. `startsWith(getAutoMemPath())`。

**边界**
- 这是“快速路径判定”，不是 TeamMem 那种 realpath 级防逃逸验证。

---

## 三十八、逐函数实现剖析（B）：`src/memdir/memdir.ts`

### 38.1 `truncateEntrypointContent(raw)`

**职责**  
裁剪 `MEMORY.md` 并附带诊断元数据，避免索引过长拖垮 prompt。

**输入/输出**
- 输入：原始 entrypoint 文本；
- 输出：`{content, lineCount, byteCount, wasLineTruncated, wasByteTruncated}`。

**算法**
1. trim + split lines；
2. 判断 line cap 与 byte cap；
3. 若不超限直接返回；
4. 若超行，先按行切；
5. 若仍超字节，按最后换行切；
6. 拼接 warning 文本。

**关键实现细节**
- warning 会区分“仅行超限 / 仅字节超限 / 双超限”。

---

### 38.2 `ensureMemoryDirExists(memoryDir)`

**职责**  
确保目录存在，降低模型“先探测目录再写”的工具回合消耗。

**实现**
1. 调 fs.mkdir（递归）；
2. 异常不抛出到上层，只 debug 记录 code。

**为什么不抛错**
- prompt 构建阶段不应因目录权限问题阻塞整个系统；真正写文件时工具层会给出明确错误。

---

### 38.3 `logMemoryDirCounts(memoryDir, baseMetadata)`

**职责**  
异步统计目录 file/subdir 数量并埋点。

**实现**
- fire-and-forget `readdir`，成功记录 counts，失败记录基础事件。

---

### 38.4 `buildMemoryLines(displayName, memoryDir, extraGuidelines?, skipIndex?)`

**职责**  
构造系统提示词中的“记忆行为协议”文本。

**核心内容块**
1. 记忆目标叙述；
2. 保存触发条件（显式 remember/forget）；
3. 类型学（四类）；
4. 不应保存项；
5. 保存流程（含 frontmatter 模板）；
6. 访问记忆时机与漂移验证；
7. 与 plan/tasks 的职责边界；
8. 搜索历史上下文建议（可选 gate）。

**`skipIndex` 分支意义**
- 在某些 gate 下弱化 index 维护要求，减少模型做机械索引更新。

---

### 38.5 `buildMemoryPrompt(params)`

**职责**  
为 agent memory 构建“行为协议 + 当前 MEMORY.md 内容”完整 prompt。

**实现步骤**
1. 读取 entrypoint（sync read，因 prompt 构建是同步路径）；
2. 构建基础 lines；
3. 若有内容，先 `truncateEntrypointContent` 再注入；
4. 否则注入“empty memory”提示；
5. join 输出字符串。

**副作用**
- 会触发 memory dir telemetry。

---

### 38.6 `buildAssistantDailyLogPrompt(skipIndex?)`

**职责**  
KAIROS 模式下，将“写 topic/index”范式切换为“按日 append-only log”。

**关键点**
- 路径用模式字符串 `YYYY/MM/YYYY-MM-DD.md`，避免缓存 prompt 因跨日失效；
- 由 nightly dream 任务做后续蒸馏。

---

### 38.7 `buildSearchingPastContextSection(autoMemDir)`

**职责**  
可选注入“如何 grep memory/transcript”指导。

**实现**
- gate 关闭 -> 空数组；
- 否则根据是否 embedded tools/REPL，生成 grep shell 命令或 Grep tool 形式。

---

### 38.8 `loadMemoryPrompt()`

**职责**  
统一选择最终 memory prompt 变体。

**执行步骤**
1. 读取 autoEnabled + skipIndex；
2. KAIROS 分支优先；
3. TEAMMEM 分支；
4. auto-only 分支；
5. disabled 分支记录 telemetry 并返回 null。

**为什么是统一入口**
- 避免调用方自己拼策略，保证所有模式行为一致。

---

## 三十九、逐函数实现剖析（C）：`findRelevantMemories.ts` 与 `memoryScan.ts`

### 39.1 `scanMemoryFiles(memoryDir, signal)`

**职责**  
扫描候选记忆头信息，供召回与抽取复用。

**实现步骤**
1. `readdir(recursive)` 获取条目；
2. 过滤 `.md` 且排除 `MEMORY.md`；
3. 并发读取每个文件前 `FRONTMATTER_MAX_LINES`；
4. 解析 frontmatter（description/type）；
5. `Promise.allSettled` 过滤失败项；
6. 按 `mtimeMs` 新到旧排序；
7. 截断到 `MAX_MEMORY_FILES`。

**复杂度**
- 近似 O(N log N)，N capped（200）时稳定。

---

### 39.2 `findRelevantMemories(query, memoryDir, signal, recentTools, alreadySurfaced)`

**职责**  
返回“最相关且未被展示过”的记忆路径列表（含 mtime）。

**算法**
1. `scanMemoryFiles` 后先过滤 `alreadySurfaced`；
2. 调 `selectRelevantMemories` 获得 filename 列表；
3. filename -> header map 映射；
4. 过滤未知 filename；
5. 返回 `{path, mtimeMs}`。

**关键细节**
- 即便 selection 为空也可记录 telemetry shape（用于分析“检索执行但无命中”）。

---

### 39.3 `selectRelevantMemories(...)`

**职责**  
用 sideQuery 执行语义选择。

**输入**
- query；
- memory manifest；
- recentTools（抑制工具文档噪声）。

**实现**
1. 构造 system prompt 与 user content；
2. 指定 JSON schema 输出；
3. 解析 text block JSON；
4. 仅保留 `validFilenames`。

**失败策略**
- 异常/abort 返回空数组，不中断主回合。

---

## 四十、逐函数实现剖析（D）：`extractMemories.ts` 状态机函数

### 40.1 `countModelVisibleMessagesSince(messages, sinceUuid)`

**职责**  
计算“自游标以来可见于模型的消息数”。

**实现细节**
- 若 sinceUuid 不存在（被 compact 删除），回退为“统计全部可见消息”，避免后续永远不触发抽取。

---

### 40.2 `hasMemoryWritesSince(messages, sinceUuid)`

**职责**  
检测主链是否已写 AutoMemory。

**实现**
- 遍历 assistant content；
- 识别 tool_use 且工具名是 Edit/Write；
- 提取 file_path；
- `isAutoMemPath(file_path)`。

**作用**
- 主链已写 -> 抽取器跳过（互斥）。

---

### 40.3 `createAutoMemCanUseTool(memoryDir)`

**职责**  
定义抽取器工具权限策略。

**策略表**
- REPL: allow（内部 primitive 仍会二次校验）；
- Read/Grep/Glob: allow；
- Bash: 仅 read-only allow；
- Edit/Write: 仅 memoryDir 内 allow；
- 其他 deny。

---

### 40.4 `getWrittenFilePath(block)` / `extractWrittenPaths(agentMessages)`

**职责**
- 从 tool_use block 中提取写入路径；
- 汇总 fork agent 写入的唯一路径。

**用途**
- 统计 memory saved；
- 过滤掉 `MEMORY.md` 机械更新，仅展示 topic 文件。

---

### 40.5 `initExtractMemories()`

**职责**  
初始化闭包状态与公开执行器。

**创建的内部状态**
- `inFlightExtractions`
- `lastMemoryMessageUuid`
- `inProgress`
- `pendingContext`
- `turnsSinceLastExtraction`

**为什么闭包化**
- 测试可重置；
- 避免全局状态跨场景污染。

---

### 40.6 `executeExtractMemories(context, appendSystemMessage?)`

**职责**  
公开入口。若未初始化则 no-op。

**调用链**
- `query/stopHooks.ts` fire-and-forget 调用。

---

### 40.7 `drainPendingExtraction(timeoutMs?)`

**职责**  
尽力等待 in-flight 提取完成，用于进程收尾阶段。

---

## 四十一、逐函数实现剖析（E）：`SessionMemory` 与 `SessionMemoryUtils`

### 41.1 `shouldExtractMemory(messages)`

**职责**  
判定本轮是否触发 session memory 更新。

**条件组合**
1. 初始化阈值（context token >= minimumMessageTokensToInit）；
2. 更新阈值（tokens since last extraction >= minimumTokensBetweenUpdate）；
3. 工具调用阈值或自然回合断点；
4. 满足时更新 `lastMemoryMessageUuid`。

**关键语义**
- token 阈值是硬前提，避免频繁小更新。

---

### 41.2 `setupSessionMemoryFile(toolUseContext)`

**职责**
- 建立 session memory 文件与模板；
- 读取当前内容。

**实现步骤**
1. mkdir dir（700）；
2. 文件不存在则创建（600）并写模板；
3. 清 `readFileState` 缓存；
4. 调 FileReadTool 读取真实内容。

**重要细节**
- 清缓存是为了避免 `file_unchanged` 短路影响后续 edit。

---

### 41.3 `extractSessionMemory`（sequential 包装）

**职责**
- post-sampling hook 主体；
- 串行保证避免并发写 session note。

**执行流程**
1. 校验 querySource（仅主线程）；
2. gate 判定；
3. 初始化远端配置；
4. `shouldExtractMemory` 判定；
5. setup file + build prompt；
6. `runForkedAgent` 执行；
7. 记录 token 基线、更新 summarized id。

---

### 41.4 `manuallyExtractSessionMemory(messages, toolUseContext)`

**职责**
- `/summary` 等手动触发路径；
- 跳过自动阈值，直接做一次提取。

**实现差异**
- 手工构造 cacheSafeParams（系统 prompt + user/system context + fork messages）。

---

### 41.5 `createMemoryFileCanUseTool(memoryPath)`

**职责**
- 仅允许 FileEdit 且 file_path 精确等于 memoryPath。

---

### 41.6 `sessionMemoryUtils.ts` 核心函数组

#### 状态读写
- `getLastSummarizedMessageId`
- `setLastSummarizedMessageId`
- `markExtractionStarted/Completed`
- `recordExtractionTokenCount`

#### 阈值判定
- `hasMetInitializationThreshold`
- `hasMetUpdateThreshold`
- `getToolCallsBetweenUpdates`

#### 生命周期辅助
- `waitForSessionMemoryExtraction`（软超时 + stale 判断）
- `getSessionMemoryContent`
- `resetSessionMemoryState`

这些函数让 `sessionMemory.ts` 的主流程保持简洁，把状态管理与阈值逻辑解耦。

---

## 四十二、逐函数实现剖析（F）：`sessionMemoryCompact.ts`

### 42.1 `hasTextBlocks(message)`

**职责**
- 判定消息是否包含文本内容，用于最小文本消息数约束。

### 42.2 `getToolResultIds` / `hasToolUseWithIds`

**职责**
- 为不变量修复提供基础查询能力。

### 42.3 `adjustIndexToPreserveAPIInvariants(messages, startIndex)`

**职责**
- 保证 compact 切片不破坏工具配对与 message 分片连续性。

**步骤**
1. 收集 kept range tool_result IDs；
2. 计算缺失 tool_use IDs；
3. 向前补齐缺失 tool_use；
4. 收集 kept range assistant message.id；
5. 向前补齐同 message.id 前序分片。

### 42.4 `calculateMessagesToKeepIndex(messages, lastSummarizedIndex)`

**职责**
- 在 min/max token、min text block 约束下计算保留起点。

**实现**
- 从 `lastSummarized+1` 开始；
- 不足则向前扩展；
- 到 max cap 或满足 min 条件停止；
- 最后做不变量修正。

### 42.5 `trySessionMemoryCompaction(...)`

**职责**
- 试图用 session memory 替代传统 compact summary；
- 失败则安全返回 `null`，让上层 fallback。

**关键分支**
- no file / empty template / summarized id missing / threshold exceeded 均走 null。

---

## 四十三、逐函数实现剖析（G）：`teamMemorySync/index.ts`

### 43.1 `createSyncState()`

**职责**
- 初始化同步状态容器。

### 43.2 `hashContent(content)`

**职责**
- 生成 `sha256:<hex>`，与服务端 `entryChecksums` 格式对齐。

### 43.3 `fetchTeamMemoryOnce(...)` / `fetchTeamMemory(...)`

**职责**
- 拉取远端 team memory（含 304/404 语义处理）；
- 外层封装重试。

**关键语义**
- 304：not modified；
- 404：远端无数据；
- 200：解析 schema + 刷新 checksum。

### 43.4 `fetchTeamMemoryHashes(...)`

**职责**
- 冲突路径下的轻量探针：只拿 hashes，不拉正文。

**意义**
- 解决 412 后“只想知道谁变了，不想下载全量正文”的效率问题。

---

### 43.5 `batchDeltaByBytes(delta)`

**职责**
- 以请求体字节为约束切批。

**算法**
1. key 排序（稳定批次）；
2. 估算 entry 边际字节；
3. 贪心塞批，超限则开新批；
4. 返回批次数组。

### 43.6 `uploadTeamMemory(...)`

**职责**
- 执行单次 PUT（可带 If-Match）；
- 识别 412 conflict；
- 识别 413 结构化错误并提取 server limit。

### 43.7 `readLocalTeamMemory(maxEntries)`

**职责**
- 递归读取本地 team files；
- 过滤超大文件；
- secret scan；
- 在 learned maxEntries 下做确定性截断。

### 43.8 `writeRemoteEntriesToLocal(entries)`

**职责**
- 将远端 entries 写回本地（路径校验 + unchanged skip）。

**关键点**
- 先读 compare，内容相同则不写，避免 mtime 抖动和 watcher 假事件。

---

### 43.9 `pullTeamMemory(state, options?)`

**职责**
- 从远端拉取并落盘；
- 刷新 `serverChecksums`；
- 写入成功时清理 memory file cache。

### 43.10 `pushTeamMemory(state)`

**职责**
- 计算 delta 上传；
- 处理 conflict probe/retry；
- 处理 secret skip；
- 返回结构化结果（成功/失败原因）。

### 43.11 `syncTeamMemory(state)`

**职责**
- pull 再 push 的双向同步入口。

---

### 43.12 `logPull` / `logPush`

**职责**
- 统一事件埋点出口，携带状态、时长、错误分型、批次数等。

---

## 四十四、你要的“实现了什么，怎么实现”的一句话速览（函数版）

为了你快速检索，这里给出极简索引：

- `isAutoMemoryEnabled`：实现“是否开记忆”，通过 env/settings 多级短路实现。
- `getAutoMemPath`：实现“记忆目录解析”，通过 override 优先 + memoize 实现。
- `truncateEntrypointContent`：实现“索引控长”，通过行优先 + 字节兜底截断实现。
- `buildMemoryLines`：实现“行为协议注入”，通过模板化 section 拼装实现。
- `findRelevantMemories`：实现“相关召回”，通过 header 扫描 + sideQuery 选择实现。
- `startRelevantMemoryPrefetch`：实现“查询期预取”，通过异步 promise + abort 绑定实现。
- `createAutoMemCanUseTool`：实现“后台权限沙箱”，通过工具名/路径白名单实现。
- `runExtraction`：实现“回合后自动抽取”，通过互斥判定 + forked agent + trailing run 实现。
- `shouldExtractMemory`：实现“session 更新触发”，通过 token/tool 双阈值实现。
- `adjustIndexToPreserveAPIInvariants`：实现“compact 正确性”，通过工具配对/分片回溯修正实现。
- `pushTeamMemory`：实现“团队增量同步”，通过 hash delta + 412 probe 重算实现。
- `validateTeamMemKey`（teamMemPaths）：实现“路径安全”，通过规范化 + realpath containment 实现。

---

## 四十五、下一步（若继续要更深）

如果你继续要“函数级更深一层”（接近代码审计报告），我可以再补三部分：

1. **逐函数伪代码对照真实代码块**（每函数 20-40 行伪代码）；
2. **每函数的输入域/输出域与不变量列表**（形式化规格）；
3. **每函数的失败注入用例模板**（可直接转测试文件）。



---

