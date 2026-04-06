# 分册 01：总览与架构叙事

> **节选来源**：[claude-code-memory-system-deep-analysis.md](./claude-code-memory-system-deep-analysis.md)（完整合订本，保留不变）  
> **分析源码树**：`D:\work\claude-code-source`  
> **本册对应合订本章节**：摘要～结语、执行摘要（一）～结论（二十）。

---

# Claude Code 记忆系统论文式深度技术文档

> 研究对象：`D:\work\claude-code-source`  
> 目标：不是“功能介绍”，而是从系统工程视角，把 Claude Code 记忆系统讲成一篇可用于架构评审、研发 onboarding、二次开发设计的技术论文。  
> 阅读建议：先看第 1-4 章建立全局模型，再按第 5-11 章逐条跟实现细节，最后看第 12-16 章进行工程落地与演进。

---

## 摘要

Claude Code 的记忆系统并非单一“把文本写入某个文件”的模块，而是一个跨越提示词构建、会话运行时、后台异步代理、上下文压缩与团队同步协议的复合系统。它在实现上分化为六条能力链：指令记忆加载、自动持久记忆、相关记忆召回、回合后记忆抽取、会话记忆与压缩协同、团队记忆远端同步。六条链路共享若干设计原则：最小权限、按需注入、状态可追踪、失败可恢复、行为可观测。

如果把问题抽象成工程命题，这个系统试图同时满足三组冲突目标：

1. **长期一致性 vs 上下文成本**：长期沉淀信息，但不能持续全量注入；
2. **自动化沉淀 vs 错误写入风险**：要自动提取，但不能污染记忆库；
3. **团队共享协作 vs 安全边界**：要跨人同步，但不能泄露敏感信息或越权写盘。

本系统的核心解法是“分层 + 分时 + 分权限”：

- 分层：把指令、长期记忆、会话记忆、团队同步解耦；
- 分时：把 prompt-time、query-time、post-turn、compact-time 的动作拆开；
- 分权限：后台代理只拿到严格受限工具与受限路径。

---

## 1. 研究问题与分析框架

### 1.1 本文回答什么问题

本文不是告诉你“有哪些文件”，而是回答以下高价值问题：

- Claude Code 为什么要有多套记忆，而不是一套？
- 每条记忆链路在什么时机触发，如何避免互相打架？
- 相关召回（relevant memories）如何做到“有用而不噪声”？
- 后台抽取器如何避免重复写、越权写、并发重入？
- Session Memory 如何保障 compact 后仍满足 API 不变量？
- Team Memory 如何在冲突、限额、网络失败中保持可收敛？
- 这套设计背后的方法论是什么，未来如何演进？

### 1.2 分析方法

采用“结构-行为-约束”三层法：

1. **结构层**：模块边界、数据模型、目录组织；
2. **行为层**：时序、状态转换、错误分支；
3. **约束层**：安全、性能、一致性、可观测性。

---

## 2. 系统全景：六层记忆栈

在 `claude-code-source` 中，记忆能力可抽象为如下栈：

1. **Instruction Memory**（`CLAUDE.md` 体系）  
   目标：行为规范与规则约束，强调“怎么做”。

2. **Auto Memory (Memdir)**（`memory/`）  
   目标：跨会话沉淀用户/反馈/项目/外部引用信息，强调“记住什么”。

3. **Relevant Memory Retrieval**（运行时附件）  
   目标：按当前 query 选最相关少量记忆，强调“现在该看什么”。

4. **Extract Memories**（回合后后台抽取）  
   目标：当主代理没有主动写记忆时，自动补齐可沉淀信息。

5. **Session Memory**（会话摘要）  
   目标：服务长会话连续性，强调“当前会话进展”。

6. **Team Memory Sync**（`memory/team/` + 远端）  
   目标：组织协作共享，强调“跨成员共享与冲突收敛”。

这个分层决定了“同样叫 memory，职责并不相同”：  
Instruction Memory 是规则；Auto/Team Memory 是长期知识；Session Memory 是会话桥梁。

---

## 3. 代码地图：关键模块与职责

### 3.1 路径与门控

- `src/memdir/paths.ts`
  - `isAutoMemoryEnabled()`
  - `getAutoMemPath()`
  - `getAutoMemEntrypoint()`
  - `isAutoMemPath()`

### 3.2 Prompt 构建

- `src/memdir/memdir.ts`
  - `truncateEntrypointContent()`
  - `buildMemoryLines()`
  - `buildMemoryPrompt()`
  - `loadMemoryPrompt()`

- `src/memdir/memoryTypes.ts`
  - 类型学、写入准则、召回验证准则

### 3.3 指令记忆与文件装载

- `src/utils/claudemd.ts`
  - `getMemoryFiles()`
  - `processMemoryFile()`
  - `getClaudeMds()`
  - include 与排除逻辑

### 3.4 相关记忆召回

- `src/memdir/memoryScan.ts`
- `src/memdir/findRelevantMemories.ts`
- `src/utils/attachments.ts`

### 3.5 后台抽取

- `src/services/extractMemories/extractMemories.ts`
- `src/query/stopHooks.ts`
- `src/utils/backgroundHousekeeping.ts`

### 3.6 会话记忆与压缩

- `src/services/SessionMemory/sessionMemory.ts`
- `src/services/SessionMemory/sessionMemoryUtils.ts`
- `src/services/SessionMemory/prompts.ts`
- `src/services/compact/sessionMemoryCompact.ts`

### 3.7 团队记忆同步

- `src/memdir/teamMemPaths.ts`
- `src/services/teamMemorySync/index.ts`
- `src/services/teamMemorySync/watcher.ts`
- `src/services/teamMemorySync/teamMemSecretGuard.ts`

### 3.8 子代理记忆

- `src/tools/AgentTool/agentMemory.ts`
- `src/tools/AgentTool/agentMemorySnapshot.ts`

---

## 4. 统一语义模型：四类记忆 + 三类时间

### 4.1 四类记忆（业务语义）

在 `memoryTypes.ts` 中，Auto/Team 记忆被严格约束为：

- `user`：关于用户角色、偏好、能力背景；
- `feedback`：用户对协作方式的纠偏与肯定；
- `project`：不可从代码直接推导的项目状态事实；
- `reference`：外部系统入口索引（看板、工单、频道等）。

### 4.2 三类时间（系统语义）

系统把“记忆动作”拆到三种时间域：

1. **Prompt-time**：系统提示词构建时（加载规则与索引）；
2. **Query-time**：单轮请求执行时（相关记忆预取与注入）；
3. **Post-turn/Compact-time**：回合结束后与压缩前（抽取、会话摘要、重构上下文）。

这三类时间解耦是系统可维护性的核心。否则所有逻辑混在主回合里会导致：

- 时延抖动；
- 过度写入；
- 难以做失败恢复。

---

## 5. Prompt-time：Auto Memory 的实现原理

### 5.1 为什么用 `MEMORY.md` + topic 文件

实现不是把所有记忆堆在一个巨型文件，而是：

- `MEMORY.md` 作为索引；
- 每个主题一个独立文件（frontmatter + 正文）；
- 索引只放短 hook，不放正文。

原理优势：

1. 索引可稳定注入，控制 token；
2. 正文可按需读取，减少上下文污染；
3. 主题文件可独立更新，不需重写全集。

### 5.2 入口截断算法

`truncateEntrypointContent(raw)` 的关键点：

1. 先做 `trim + split('\n')`；
2. 检查行上限（`MAX_ENTRYPOINT_LINES`）；
3. 检查字节上限（`MAX_ENTRYPOINT_BYTES`）；
4. 行截断优先，随后按最后换行做字节截断；
5. 拼接 warning 说明具体截断原因。

这避免了“仅按行限制”在长行场景失效，也避免了“硬按字节砍中间”破坏语义边界。

### 5.3 `loadMemoryPrompt()` 分发策略

`loadMemoryPrompt()` 本质是记忆策略总开关：

- KAIROS 模式：走 append-only daily log；
- TEAMMEM 开启：走 combined prompt（private + team 两目录）；
- 否则 auto-only；
- AutoMemory 关闭则返回 `null`。

并且在 prompt 构建阶段尝试 `ensureMemoryDirExists`，减少模型在执行层浪费回合检查目录。

### 5.4 方法论

这一层遵循的方法论是：

- **强提示弱注入**：先把行为规范写清楚，再把内容最小化注入；
- **索引常驻正文按需**：稳定成本与高信息密度兼得；
- **将路径可用性前置**：减少代理“确认目录是否存在”的无效操作。

---

## 6. Query-time：相关记忆召回的实现与算法

### 6.1 召回链路总览

运行链路可表示为：

1. 从用户最后一条有效输入提取 query；
2. `scanMemoryFiles(memoryDir)` 获取候选头信息；
3. 构建 manifest 文本；
4. `selectRelevantMemories()` 调 sideQuery（Sonnet）返回文件名集合；
5. 回读每个候选文件前 N 行/N 字节；
6. 形成 `relevant_memories` attachment 注入；
7. 与 `readFileState`、历史 surfacing 集合去重。

### 6.2 候选扫描器

`memoryScan.ts` 里：

- 递归读取目录，过滤 `.md` 且排除 `MEMORY.md`；
- 只读前若干行 frontmatter（`FRONTMATTER_MAX_LINES`）；
- 提取 `description/type/mtime`；
- 新到旧排序，最多 200 文件。

该算法复杂度可近似为：

- 目录遍历 O(N)
- 每文件头部读取 O(1)（上限行截断）
- 排序 O(N log N)

N 上限 200 时排序与 I/O 都可控。

### 6.3 选择器为何用 sideQuery

`findRelevantMemories.ts` 并不做关键词打分，而是把 query + manifest 交给模型选择。

原因：

- frontmatter description 是自然语言，不是结构化向量库；
- “是否有帮助”通常是语义判断，不是词面 overlap；
- 还能融合 `recentTools` 规避“工具文档噪声”。

实现上通过 JSON schema 约束输出，避免自由文本失控。

### 6.4 预取策略与取消机制

`attachments.ts` 的 `startRelevantMemoryPrefetch()`：

- 在主回合开始前异步启动；
- 绑定 turn abort controller；
- 若用户中断可立即取消 sideQuery；
- 单词输入不触发（减少低质量召回）。

这是一种“投机执行”策略：  
预取成功时降低首 token 延迟；失败时不阻塞主流程。

### 6.5 去重机制为何是双重

去重来源有两类：

1. `alreadySurfaced`：历史已注入记忆路径；
2. `readFileState`：模型已通过文件工具读过的文件。

双重去重的意义：

- 避免重复塞相同上下文；
- 把注入预算留给新增且未读的信息；
- 防止多目录并行召回时同一路径回流。

### 6.6 方法论

这一层的核心方法论是：

- **先粗选候选，再语义精选，再预算裁剪**；
- **召回不是越多越好，而是“边际价值最大化”**；
- **把“相关性选择”与“内容读取”分离，便于各自优化。**

---

## 7. Post-turn：后台抽取器的状态机实现

### 7.1 触发与生命周期

抽取器初始化在 `backgroundHousekeeping`：

- `initExtractMemories()` 创建闭包状态；
- `handleStopHooks()` 在主回合结束 fire-and-forget 调 `executeExtractMemories()`；
- `drainPendingExtraction()` 在进程退出前尽力等待。

### 7.2 闭包状态变量

`extractMemories.ts` 用闭包维护状态，而非模块全局常量：

- `lastMemoryMessageUuid`：已处理游标；
- `inProgress`：是否执行中；
- `pendingContext`：执行期间到来的最新上下文；
- `turnsSinceLastExtraction`：节流计数；
- `inFlightExtractions`：可 drain 的 promise 集合。

这是显式状态机设计，便于测试重置和并发推理。

### 7.3 “主写优先”互斥机制

`hasMemoryWritesSince()` 扫描 assistant tool_use：

- 若发现 Edit/Write 目标是 AutoMem 路径，抽取器跳过；
- 游标推进到当前末尾；
- 记录 skip telemetry。

这条规则解决了实际生产中最容易出现的问题：  
主代理已写，后台又写，造成重复或冲突更新。

### 7.4 工具权限边界

`createAutoMemCanUseTool(memoryDir)` 把抽取器锁进白名单：

- 可读工具开放；
- Bash 仅允许只读命令；
- 写工具仅限 `memoryDir` 内；
- 其他工具全部 deny。

这相当于给后台代理加了“能力阉割层”，使其退化为安全可控的文本整理器。

### 7.5 并发合并策略

如果新一轮到来时抽取在跑：

- 不并发新开任务；
- 仅覆盖 `pendingContext` 为最新；
- 当前任务结束后跑一次 trailing extraction。

这是“最后写者获胜”的合并策略，避免队列膨胀。

### 7.6 方法论

这层体现的工程方法论是：

- **互斥优先于并行**（先保证不冲突，再考虑吞吐）；
- **后台任务必须可丢弃、可合并、可回放**；
- **权限收敛是后台自动化的第一原则。**

---

## 8. Session Memory：从“笔记”到“压缩语义桥”

### 8.1 设计初衷

Session Memory 不是长期知识库，而是“会话状态寄存器”：

- 把当前进展结构化落盘；
- 在 compact 时充当高密度摘要源；
- 防止长会话后段丢失关键上下文。

### 8.2 更新机制

`sessionMemory.ts` 的决策逻辑：

1. 满足 gate；
2. 达到初始化 token 门槛；
3. 达到更新门槛（token 增量 + tool call 条件）；
4. 创建/读取 session memory 文件；
5. 构建更新 prompt；
6. forked agent 执行 edit。

### 8.3 为何只允许 Edit 单文件

`createMemoryFileCanUseTool(memoryPath)` 只允许对单一目标文件 `Edit`。  
这是将任务能力限制为“纯文本更新”，防止 session 代理偏航到项目代码。

### 8.4 模板与结构保护

`SessionMemory/prompts.ts` 强调：

- header 与 italic 说明行必须保留；
- 只允许修改内容区；
- 各 section 有长度约束与超长压缩提醒。

本质上是把笔记写作转成“结构化编辑协议”，降低模型自由发挥导致的格式漂移。

---

## 9. Compact-time：SessionMemoryCompact 的协议级保障

### 9.1 为什么需要专门 compact 模块

传统 compact 仅做历史摘要可能导致：

- tool_use / tool_result 对被切断；
- 流式分片 message.id 同族消息丢失；
- 压缩后 API 入参非法或语义不完整。

`sessionMemoryCompact.ts` 直接把这些当成 API 不变量处理，而不是“最佳努力”。

### 9.2 起点计算算法

`calculateMessagesToKeepIndex()` 逻辑：

1. 从 `lastSummarizedMessageId` 后开始；
2. 向后扩展直到满足最小 token 与最小文本消息数；
3. 到达最大 token cap 停止；
4. 调 `adjustIndexToPreserveAPIInvariants()` 修正边界。

### 9.3 不变量修正

`adjustIndexToPreserveAPIInvariants()` 会：

- 扫描保留区内所有 tool_result ID；
- 向前回溯缺失的 tool_use；
- 检查同 message.id 的前序 assistant 分片，必要时前移起点。

它修复的是“协议一致性”，而不只是“信息完整性”。

### 9.4 方法论

这层的核心思想：

- **上下文压缩必须先满足协议，再追求摘要质量**；
- **边界切片是系统正确性问题，不是文案问题**。

---

## 10. Team Memory Sync：分布式协作协议实现

### 10.1 同步语义

`teamMemorySync/index.ts` 描述的语义：

- pull：服务端内容覆盖本地同 key；
- push：只上传本地 hash 与服务端 hash 不同的 key；
- 删除不传播：本地删除不会自动删服务端。

### 10.2 数据结构

`SyncState` 关键字段：

- `lastKnownChecksum`：用于 If-Match/If-None-Match；
- `serverChecksums`：每 key 的 `sha256:<hex>`；
- `serverMaxEntries`：从 413 响应学习出的服务端上限。

这使同步具备“增量判定 + 乐观并发 + 动态限额适配”能力。

### 10.3 增量上传算法

核心步骤：

1. 本地读出 entries；
2. 每 entry 计算 hash；
3. 与 `serverChecksums` 对比形成 delta；
4. delta 为空直接成功；
5. delta 按请求体大小切批；
6. 批量 PUT，成功后更新 `serverChecksums`；
7. 若 412，拉 hashes 重算 delta 重试。

这是标准“内容寻址同步”协议，避免每次全量上传。

### 10.4 冲突处理策略

系统采用“同 key local-wins（push 时）”策略：

- 优先保证本地用户刚做的编辑不被静默吞掉；
- 牺牲的是并发同 key 合并能力（无三方合并）。

这是一种偏产品可解释性的折中：  
“用户刚改完却没生效”比“需要后续人工整合同 key”更不可接受。

### 10.5 watcher 运行时机制

`watcher.ts`：

- 启动时先 pull，再 watch；
- 文件变化 debounce 后 push；
- 永久性失败场景（如 no_oauth/no_repo）进入 suppression，防止日志风暴；
- unlink 可清 suppression，支持恢复路径。

---

## 11. 安全模型：威胁、对策、代码落点

### 11.1 威胁 A：路径穿越/符号链接逃逸

攻击面：

- 通过 `..`、编码绕过、symlink 指向敏感目录，诱导写出 team 目录外。

对策：

- `sanitizePathKey()` 拒绝 null byte、编码穿越、unicode 归一化穿越；
- `resolve` 前缀校验；
- `realpathDeepestExisting()` + `isRealPathWithinTeamDir()` 真实路径 containment 校验；
- dangling symlink 与 symlink loop 显式判错。

实现点：

- `src/memdir/teamMemPaths.ts`

### 11.2 威胁 B：敏感信息同步泄漏

攻击面：

- 模型把 token/key/凭据写入 team memory，并被上传到服务端共享。

对策：

1. 写入时拦截：`checkTeamMemSecrets(filePath, content)`；
2. push 前扫描：`scanForSecrets(content)` 命中文件直接跳过并告警。

实现点：

- `src/services/teamMemorySync/teamMemSecretGuard.ts`
- `src/services/teamMemorySync/index.ts`

### 11.3 威胁 C：后台代理越权

攻击面：

- extract/session/auto-dream 子代理调用非预期工具修改项目代码。

对策：

- 每个后台代理都有独立 `canUseTool` 白名单；
- 写入路径限制到 memory 子树或单文件；
- Bash 只读判定。

实现点：

- `extractMemories.ts`
- `sessionMemory.ts`

---

## 12. 性能模型与复杂度分析

### 12.1 召回性能

- 扫描头部而非全文件：I/O 由 O(total_file_size) 降为 O(file_count)；
- 预取并行：与主回合并发，降低用户感知延迟；
- 会话级注入预算：防止长期会话内存附件失控。

### 12.2 抽取性能

- forked agent 复用 cache 前缀，减少重复 token；
- main-write skip 机制减少重复抽取；
- coalescing 降低并发开销。

### 12.3 同步性能

- delta 上传降低网络体积；
- batch by bytes 规避网关 413；
- unchanged 文件不重写，减少本地抖动与 watcher 噪声。

### 12.4 压缩性能

- session summary 作为高密度信息源，减少 compact 后 token 回弹；
- 不变量修正避免 API 重试成本。

---

## 13. 方法论总结：这套系统“怎么设计出来的”

从源码看，Claude Code 记忆系统背后的方法论可以提炼为七条：

1. **职责正交**：把“规则”“长期记忆”“会话摘要”“团队同步”拆开；
2. **时间解耦**：不同动作放在不同生命周期执行；
3. **按需注入**：常驻最小索引，正文按相关性召回；
4. **后台兜底**：主路径不强依赖抽取，抽取做补位；
5. **最小权限**：后台代理能力严格收敛；
6. **失败可恢复**：冲突重试、抑制风暴、可回放；
7. **可观测优先**：关键分支都埋点，便于线上诊断。

这不是“写提示词”能解决的问题，而是典型的系统工程设计。

---

## 14. 端到端时序（文字版）

### 14.1 启动阶段

1. `startBackgroundHousekeeping()` 调 `initExtractMemories()`、`initAutoDream()`；
2. 若 team 条件满足，`startTeamMemoryWatcher()`：
   - 先 pull；
   - 再 watch。

### 14.2 单轮 query 阶段

1. `attachments` 启动 relevant memory prefetch；
2. 主模型执行；
3. `stopHooks` 结束后 fire-and-forget:
   - `executeExtractMemories()`
   - `executeAutoDream()`
4. 下轮开始时，已注入内容参与 `alreadySurfaced` 去重。

### 14.3 compact 阶段

1. 先尝试 session memory compaction；
2. 若条件不满足或异常，fallback legacy compact；
3. 保证 tool/result 对与 message.id 分片完整。

---

## 15. 可扩展性与改进建议（工程落地）

### 15.1 建议 A：记忆质量评分器

新增离线/在线评分：

- description 信息密度；
- 类型判定一致性；
- 重复率；
- 过期风险。

用于指导抽取器“写什么”和召回器“信什么”。

### 15.2 建议 B：TeamMem 软删除协议

当前删除不传播，建议引入 tombstone 机制：

- 客户端记录 soft_delete_keys；
- 服务端合并时应用删除；
- 保留审计时间戳与恢复窗口。

### 15.3 建议 C：召回可解释性层

为每次 relevant selection 记录内部 reason tag（不对用户暴露）：

- query-term overlap
- type-priority
- freshness boost
- warning/gotcha boost

便于诊断误召回。

### 15.4 建议 D：冲突三方合并实验

针对 TeamMem 同 key 冲突，实验可选三方合并：

- 代价：复杂度显著上升；
- 收益：减少 local-wins 覆盖同 key 同时编辑的损失。

---

## 16. 附录：源码阅读路线（论文复现实验版）

### 16.1 第一阶段：建立心智模型

1. `src/memdir/paths.ts`
2. `src/memdir/memoryTypes.ts`
3. `src/memdir/memdir.ts`

目标：理解“什么时候开、写什么、怎么注入”。

### 16.2 第二阶段：理解运行时召回

1. `src/memdir/memoryScan.ts`
2. `src/memdir/findRelevantMemories.ts`
3. `src/utils/attachments.ts`

目标：理解“如何按 query 召回且不污染上下文”。

### 16.3 第三阶段：理解后台抽取与会话桥接

1. `src/services/extractMemories/extractMemories.ts`
2. `src/services/SessionMemory/sessionMemory.ts`
3. `src/services/compact/sessionMemoryCompact.ts`

目标：理解“回合后补位 + compact 连续性保证”。

### 16.4 第四阶段：理解团队同步与安全

1. `src/memdir/teamMemPaths.ts`
2. `src/services/teamMemorySync/index.ts`
3. `src/services/teamMemorySync/watcher.ts`
4. `src/services/teamMemorySync/teamMemSecretGuard.ts`

目标：理解“分布式同步协议 + 安全边界”。

---

## 结语

`D:\work\claude-code-source` 的记忆系统，真正复杂的地方不在“写文件”，而在：

- 如何让记忆在正确时机生效；
- 如何让自动化写入不破坏系统稳定性；
- 如何让团队共享在冲突和安全约束下可收敛；
- 如何在成本受限下保持信息增益。

从源码实现看，这套系统的成熟度已经接近“可长期演化的基础设施层”，而非单点功能。  
如果你后续要做二次开发，建议以“分层 + 生命周期 + 权限边界”三条主线来改，而不是在单个模块上做局部补丁。

# Claude Code 记忆系统深度技术文档（`D:\work\claude-code-source`）

> 文档定位：面向架构师、核心开发者、维护者。  
> 文档目标：对 `D:\work\claude-code-source` 里的“记忆系统”做系统性拆解，覆盖实现细节、数据流、状态机、安全边界、性能策略与演进方向。  
> 文档范围：以源码中 `memdir`、`attachments`、`extractMemories`、`SessionMemory`、`teamMemorySync`、`AgentMemory` 相关模块为核心。

---


## 一、执行摘要（Executive Summary）

Claude Code 的“记忆系统”并不是单个数据库或单个文件，而是一个**多层次、异步协同、受策略门控（feature gate + env + settings）**的复合系统。它由六条能力线并行组成：

1. **指令记忆（Instruction Memory）**：`CLAUDE.md` 体系，强调“长期规则与行为约束”；
2. **自动记忆（Auto Memory / Memdir）**：持久跨会话记忆，索引+主题文件模型；
3. **相关召回（Relevant Memory Retrieval）**：按当前用户请求做“有限召回”；
4. **后台抽取（Extract Memories）**：回合结束后 fork 子代理自动提取可沉淀信息；
5. **会话记忆（Session Memory）**：服务上下文压缩（compact）连续性；
6. **团队记忆（Team Memory）**：`memory/team/` 与服务端双向同步（增量、冲突、密钥扫描）。

这套设计的核心价值是：

- **降低 token 常驻成本**：并非全量记忆长期注入，而是“规则常驻 + 内容按需召回”；
- **降低重复劳动**：把可复用协作偏好、项目上下文、外部系统索引沉淀下来；
- **提高长会话稳定性**：session memory 与 compact 协同，避免上下文漂移；
- **支持团队协作知识共享**：team memory 用 delta+hash 同步，而非粗暴全量覆盖；
- **安全边界强**：路径穿越、符号链接逃逸、敏感信息泄漏都有专项防护。

---

## 二、系统边界与术语

### 2.1 术语定义

- **AutoMem**：自动记忆目录，项目维度，通常是 `~/.claude/projects/<repo-key>/memory/`。
- **Entrypoint**：`MEMORY.md`，索引文件，不承载完整记忆正文。
- **Topic Memory File**：实际记忆内容文件（如 `feedback_testing_policy.md`）。
- **Relevant Memories Attachment**：每轮动态注入的相关记忆附件（非全量）。
- **ExtractMemories**：后台 fork agent，从最近对话提取可沉淀信息。
- **Session Memory**：会话级结构化笔记，主要用于 compact 语义连续。
- **TeamMem**：共享团队记忆目录（`memory/team/`）及其远端同步能力。

### 2.2 范围与非范围

**在范围内：**

- 记忆路径解析、注入、抽取、召回、同步；
- 记忆类型规范与写入约束；
- 会话记忆与压缩协同；
- 工具权限与安全策略。

**不在范围内：**

- 具体 UI 组件展示细节（如选择器渲染样式）；
- 通用命令系统非记忆功能实现；
- 大模型服务底层 SDK 细节（仅在调用语义层讨论）。

---

## 三、架构总览：六层协同模型

可以把系统抽象成以下分层：

1. **策略层（Policy/Gating）**  
   `paths.ts`、growthbook 配置、env/settings 判定启停及参数。
2. **存储层（Storage）**  
   本地文件系统（AutoMem/TeamMem/SessionMem/AgentMem）。
3. **注入层（Injection）**  
   系统 prompt 段注入 + attachment 注入（两条通路）。
4. **抽取层（Extraction）**  
   回合结束子代理抽取、会话笔记更新、auto dream consolidation。
5. **同步层（Sync）**  
   TeamMem pull/push、delta、冲突重试、watcher 防抖。
6. **可观测层（Telemetry/Debug）**  
   事件埋点、调试日志、失败分型、节流指标。

该架构的关键思想不是“一个总开关”，而是“**多个阶段都有独立门控**”。比如：

- AutoMem 可开，但 Relevant Retrieval 可由另一个 gate 单独关；
- ExtractMemories、SessionMemory、AutoDream 都有独立 gate；
- TeamMem 又受 build flag + OAuth + repo 条件三重约束。

---

## 四、路径解析与开关体系（`src/memdir/paths.ts`）

### 4.1 AutoMemory 开启判定链

`isAutoMemoryEnabled()` 的判定顺序体现“显式优先”原则：

1. 环境变量显式禁用（`CLAUDE_CODE_DISABLE_AUTO_MEMORY=true`）立即关闭；
2. 环境变量显式 false 则打开；
3. SIMPLE/`--bare` 场景关闭（保证最简执行模式）；
4. 远程模式但无持久目录时关闭；
5. 读取 settings（`autoMemoryEnabled`）；
6. 默认开启。

这意味着：系统不会因为某个局部模块默认值误开记忆，优先尊重显式配置与运行模式。

### 4.2 路径解析优先级

`getAutoMemPath()` 的优先级：

1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`（env 全路径覆盖）；
2. `settings` 的 `autoMemoryDirectory`（受信来源）；
3. 默认 `<memoryBase>/projects/<sanitized-root>/memory/`。

其中“受信来源”是安全重点：项目设置来源可能被恶意仓库污染，因此实现里刻意限制可用来源，降低“仓库诱导写入敏感目录”的风险。

### 4.3 路径安全校验要点

`validateMemoryPath()` 做了较全面的拒绝策略：

- 禁止相对路径；
- 禁止 root/near-root、Windows 盘符根；
- 禁止 UNC 网络路径；
- 禁止 null byte；
- 对 `~/` 展开也做祖先目录防护（避免展开到 home 根本身）。

这是把“路径合法性”作为**权限边界的一部分**处理，而不是 UI 层输入校验。

---

## 五、记忆类型学与内容治理（`src/memdir/memoryTypes.ts`）

### 5.1 四类 taxonomy 的工程意义

固定类型：`user`、`feedback`、`project`、`reference`。  
它们不是展示标签，而是直接影响：

- 抽取提示词语义；
- 团队/私有范围决策（combined 模式）；
- 后续召回精度（frontmatter 描述 +类型标签）。

### 5.2 “不该存什么”是系统稳定的关键

模块中明确排除：

- 代码结构、架构、路径、git 历史；
- debug recipe（应在代码/commit 中存在）；
- CLAUDE.md 已有内容；
- 当前会话临时任务状态。

这条约束解决了实践中最常见问题：  
**记忆库被“活动日志”污染，导致召回噪声 > 价值。**

### 5.3 Recall 漂移防护

`MEMORY_DRIFT_CAVEAT` 与 `TRUSTING_RECALL_SECTION` 明确要求：

- 记忆是“当时成立”的历史声明，不是当前事实；
- 涉及函数/文件/flag 的建议前需二次验证（读文件/grep）；
- 若冲突，以当前代码状态为准并更新记忆。

这是对 LLM“过度相信上下文文本”的反偏置设计。

---

## 六、Memdir Prompt 构建机制（`src/memdir/memdir.ts`）

### 6.1 Entrypoint 截断策略

`truncateEntrypointContent()` 采用双阈值：

- 先按行截断（自然边界）；
- 再按字节截断（防止极长行绕过行数限制）；
- 追加警告说明触发原因。

这种策略兼顾模型可读性与 token 可控，不会在行中间硬切导致语义破坏。

### 6.2 Prompt 变体

- **buildMemoryLines**：仅构建行为说明；
- **buildMemoryPrompt**：构建行为说明 + 注入 `MEMORY.md` 内容（常用于 agent memory）；
- **buildAssistantDailyLogPrompt**：KAIROS 长会话 append-only 日志模式；
- **buildSearchingPastContextSection**：可选注入 grep 检索建议。

### 6.3 目录存在性保证

`ensureMemoryDirExists()` 在 prompt 加载阶段尝试创建目录，且失败只打 debug 不中断。  
配合 FileWrite 工具自带 parent mkdir，形成双保险，减少模型先做 `mkdir` 的回合浪费。

### 6.4 开关分发逻辑

`loadMemoryPrompt()` 统一分支：

- KAIROS 优先；
- TeamMem（combined）次之；
- Auto-only；
- 否则 null（并记录 disabled 事件）。

这让“记忆策略选择”在系统级集中，不分散到各业务模块。

---

## 七、指令记忆加载链（`src/utils/claudemd.ts`）

### 7.1 多来源按优先级加载

注释中定义了顺序：

1. Managed memory（全局）
2. User memory
3. Project memory（CLAUDE.md / `.claude/CLAUDE.md` / rules）
4. Local memory（CLAUDE.local.md）

并且按目录层级反向优先（离当前 cwd 更近者优先）。

### 7.2 `@include` 机制与安全约束

- 支持相对/绝对/`~/` include；
- 避免循环 include；
- 限定文本扩展名，避免二进制污染上下文；
- 支持外部 include 但有审批机制；
- 通过 token 解析避免误在代码块中解析 include 指令。

### 7.3 AutoMem/TeamMem 与 CLAUDE.md 的关系

- AutoMem/TeamMem entrypoint 也会以“memory file”形式装入；
- 但在某些 gate 下可跳过 index 注入，转而依赖 relevant memory attachments；
- 系统把“指令类记忆”与“自动沉淀记忆”在 hook/审计上分开处理。

---

## 八、相关记忆召回系统（`memoryScan + findRelevantMemories + attachments`）

### 8.1 扫描器（`src/memdir/memoryScan.ts`）

- 递归读取 `.md`（排除 `MEMORY.md`）；
- 读取前 N 行 frontmatter（降低 I/O）；
- 提取 `description/type/mtime`；
- 新到旧排序，最多保留 `MAX_MEMORY_FILES`（200）。

这个扫描器是召回与抽取共用基础设施，避免模块各自重复实现目录遍历。

### 8.2 选择器（`src/memdir/findRelevantMemories.ts`）

流程：

1. 输入 query + memory manifest；
2. 通过 sideQuery 调用 Sonnet；
3. 输出 `selected_memories` 文件名列表（JSON schema 约束）；
4. 过滤非法/不存在文件名；
5. 返回绝对路径 + `mtimeMs`。

额外做法：

- 注入 recent tools：抑制“工具文档类记忆”误召回；
- alreadySurfaced 预过滤：把 5 个名额优先留给新内容。

### 8.3 附件预取（`src/utils/attachments.ts`）

`startRelevantMemoryPrefetch()` 特性：

- 每轮提前异步触发（prefetch），不阻塞主链路；
- 绑定 turn 级 abort controller，可快速取消；
- 对短输入（单词）跳过，降低噪声；
- 按会话累计 bytes 上限节流。

### 8.4 注入内容裁剪

`readMemoriesForSurfacing()` 对每个记忆文件：

- 限行（`MAX_MEMORY_LINES`）；
- 限字节（`MAX_MEMORY_BYTES`）；
- 截断后给出提示“可用 FileRead 看完整内容”。

这是“把相关性优先于完整性”的工程取舍：先给模型可用摘要，必要时再读全文件。

### 8.5 去重闭环

- `collectSurfacedMemories()` 从历史消息提取已注入路径；
- `filterDuplicateMemoryAttachments()` 与 `readFileState` 联动去重；
- 同时避免“预取写入 readFileState 导致自我过滤”的循环问题。

---

## 九、回合末抽取器（`src/services/extractMemories/extractMemories.ts`）

### 9.1 触发点与生命周期

初始化在 `backgroundHousekeeping`，执行由 `query/stopHooks` fire-and-forget 调用。  
因此它不阻塞当前回答返回，但在进程退出前可被 drain 等待一段时间。

### 9.2 关键优化：主写优先，抽取补位

`hasMemoryWritesSince()` 检测本轮 assistant 是否已对 memory 路径调用 Write/Edit。若已写：

- 抽取器直接 skip；
- 游标推进，避免下次重复处理同一区间。

这实现了“**主 agent 与抽取器互斥**”语义：

- 主 agent 已做出明确记忆决策时，后台不再重复推断；
- 主 agent 未写时，后台兜底补齐。

### 9.3 子代理权限沙箱

`createAutoMemCanUseTool(memoryDir)` 限制：

- 允许：Read/Grep/Glob；
- 允许：只读 Bash（通过 `isReadOnly` 判定）；
- 允许：Edit/Write 但仅 memoryDir 内路径；
- 允许 REPL（但 REPL 内部调用仍受同样 canUseTool 约束）；
- 禁止其它所有工具。

这保证抽取器在“最小权限”下运行，减少后台任务带来的安全面。

### 9.4 并发与尾随策略

内部状态包含：

- `inProgress`：当前是否运行；
- `pendingContext`：运行中到来的最新上下文；
- `lastMemoryMessageUuid`：已处理游标；
- `turnsSinceLastExtraction`：节流计数。

运行结束后若有 `pendingContext`，会立刻做 trailing run，确保“最终一致”。

---

## 十、Session Memory：长会话连续性的第二轨

### 10.1 设计定位

Session Memory 不是“跨会话知识库”，其核心定位是：

- 会话内状态摘要；
- compact 前后语义桥接；
- 降低长会话后半段遗忘风险。

### 10.2 文件模板驱动

`SessionMemory/prompts.ts` 默认模板包含：

- Session Title
- Current State
- Task specification
- Files and Functions
- Workflow
- Errors & Corrections
- Codebase and System Documentation
- Learnings
- Key results
- Worklog

更新规则强调“保留结构，只编辑内容区”，防止模板坍塌。

### 10.3 触发阈值模型

`sessionMemoryUtils.ts` 维护：

- 初始化 token 门槛；
- 更新 token 增量门槛；
- 工具调用门槛；
- 抽取运行状态与超时等待。

`shouldExtractMemory()` 将这些条件组合起来，避免高频无效抽取。

### 10.4 执行方式

`sessionMemory.ts` 中：

- 先确保 memory 文件存在并读取当前内容；
- 构建更新 prompt；
- 通过 forked agent 执行；
- `canUseTool` 只允许对该单一文件 `Edit`。

这个限制比 extractMemories 更严格，防止 session task 漫游。

---

## 十一、Session Memory 与 Compact 深度耦合（`sessionMemoryCompact.ts`）

### 11.1 使用条件

`shouldUseSessionMemoryCompaction()` 同时要求：

- session memory gate 开启；
- sm compact gate 开启；
- env override 允许强制开/关。

### 11.2 压缩核心思想

当 compact 触发时优先尝试：

1. 读取 session memory；
2. 根据 `lastSummarizedMessageId` 计算保留消息起点；
3. 扩展保留范围满足最小 tokens / 最小文本消息数；
4. 避免断裂 `tool_use/tool_result` 与同 `message.id` thinking 分片；
5. 用 session memory 生成 compact summary message。

### 11.3 API 不变量保护（关键）

`adjustIndexToPreserveAPIInvariants()` 解决两个高危问题：

1. **tool_result 孤儿化**：保留区包含 result 但不含对应 tool_use；
2. **thinking 分片丢失**：同 message.id 的前序思维块被裁掉。

这部分属于“协议完整性防线”，不是业务美化。若缺失，容易直接触发 API 错误。

---

## 十二、Team Memory：共享记忆同步系统

### 12.1 基本模型

- 本地目录：`getTeamMemPath()`（AutoMem 下 `team/`）
- 远端 API：GET/PULL、PUT/PUSH，支持 checksum/entryChecksums
- 同步语义：pull 覆盖本地，push 仅上传变化项（delta）

### 12.2 `SyncState` 设计

`createSyncState()` 持有：

- `lastKnownChecksum`（ETag 语义）
- `serverChecksums`（每 key hash）
- `serverMaxEntries`（从 413 响应学习）

把可变状态显式对象化，而非隐式全局，便于测试隔离与多实例控制。

### 12.3 Push 的增量算法

步骤：

1. 读取本地 entries；
2. 计算 local hash；
3. 与 serverChecksums 比较，构建 delta；
4. 若 delta 为空，短路成功；
5. 按 body bytes 切 batch；
6. 逐 batch PUT；
7. 成功后更新 serverChecksums；
8. 412 冲突时 `view=hashes` 刷新并重算 delta 重试。

这是典型的“内容寻址 + 乐观并发控制”。

### 12.4 冲突策略取舍

实现偏向 **local-wins-on-conflict（同 key）**：

- 触发 push 的本质是本地用户刚编辑过；
- 如果静默覆盖本地改动，用户损失不可接受；
- 服务端/他人同 key 变化可能被覆盖，需要后续协作修复。

这是工程上“可解释且可恢复”的取舍。

### 12.5 watcher 机制

`watcher.ts` 特点：

- 启动时先 pull，再启动 watch（即使远端为空）；
- 变更 debounce；
- push 失败抑制（如 no_oauth/no_repo/某些 4xx）防止无限重试风暴；
- unlink 可清除 suppression（针对 too-many-entries 恢复路径）。

---

## 十三、安全体系深拆

### 13.1 TeamMem 路径防逃逸（`teamMemPaths.ts`）

`validateTeamMemKey` / `validateTeamMemWritePath` 分两阶段：

1. 字符串级规范化检查（resolve 后必须仍在 teamDir 前缀内）；
2. 文件系统真实路径检查（realpath deepest existing + teamDir realpath containment）。

并检测：

- dangling symlink；
- symlink loop；
- URL 编码与 Unicode 归一化穿越；
- 反斜杠/绝对路径注入。

这套防护强于普通 `startsWith(resolve(path))`。

### 13.2 Secret Guard 双层防线

- 写工具入口处 `checkTeamMemSecrets` 可阻断写入；
- push 前 `scanForSecrets` 会跳过命中文件并记录告警。

即使某层遗漏，另一层还能兜底，防止敏感信息外传。

### 13.3 后台代理最小权限

extract/auto-dream/session-memory 都采用受限工具策略，不直接复用主线程全权限，降低“后台自动化误操作”风险。

---

## 十四、性能与成本策略

### 14.1 Token 成本控制

- `MEMORY.md` 双阈值截断；
- relevant memory 限文件数/限行/限字节；
- prefetch + cache-safe params 尽量命中 prompt cache；
- extract 与 auto-dream 都以 fork 共享缓存前缀。

### 14.2 I/O 与并发策略

- frontmatter 只读前几十行；
- TeamMem 写入前比较内容，避免无意义改写；
- TeamMem 上传按 bytes 批次化，减少网关 413；
- watcher 防抖减少频繁 push。

### 14.3 节流策略

- extract 允许“每 N 轮”执行；
- auto-dream 在 time gate 通过后仍有扫描节流；
- session memory 使用 token/tool 双门槛控制频率。

---

## 十五、可观测性与调试体系

### 15.1 事件类型

系统广泛记录：

- memory prompt load/disabled；
- relevant retrieval 形状；
- extract started/skipped/error；
- session memory init/extract/manual；
- team sync pull/push 成败、冲突、重试、413 结构信息。

### 15.2 调试价值

这些埋点可回答关键运营问题：

- 记忆是否真的在提升成功率，还是在增加噪声？
- 抽取器是否被主写覆盖导致“看似启用实则几乎不执行”？
- team sync 的冲突是否可接受？413 是否集中在少数仓库？
- session compact 是否显著降低 fallback 到旧 compact 路径的比例？

---

## 十六、失败模式与恢复机制

### 16.1 典型失败模式

1. **抽取器重复写**  
   已通过 `hasMemoryWritesSince` 基本解决。
2. **召回噪声高**  
   常见根因是 frontmatter description 质量差。
3. **team sync 冲突循环**  
   通过 hashes probe + 重算 delta 收敛。
4. **gateway 413**  
   通过按 body bytes 分批 PUT 规避。
5. **路径攻击**  
   teamMemPaths 的 realpath 验证链阻断。
6. **compact 后 API 错误**  
   通过保 pair / 保 message.id 分片防止断裂。

### 16.2 恢复思路

- 抽取问题：检查 gate、check logs、看 `skipped_direct_write` 比例；
- 召回问题：优先优化记忆 description，再调 selector prompt；
- sync 问题：看 `errorType/httpStatus`，区分权限、网络、配额；
- compact 问题：检查 `lastSummarizedMessageId` 与边界消息链。

---

## 十七、设计取舍评估

### 17.1 优点

- 模块边界清晰：注入、抽取、同步职责分层；
- 安全投入足：路径与 secret 双重防护；
- 运行时可控：多层 gate + 节流；
- 长会话可靠：session memory 与 compact 强耦合补位。

### 17.2 代价

- 路径复杂：同一“记忆”在多个模块/时机生效，理解门槛高；
- gate 组合爆炸：测试矩阵成本上升；
- 同步策略有语义代价：local-wins 可能覆盖他人同 key 更新；
- 删除不传播：远端垃圾条目治理需要外部策略。

---

## 十八、工程建议（面向后续迭代）

### 18.1 记忆质量治理

建议新增“memory lint”：

- 必填 frontmatter 检查；
- description 唯一性/区分度评分；
- 重复主题检测；
- 老化提示（project 类记忆时效衰减）。

### 18.2 TeamMem 生命周期治理

- 增加“软删除协议”字段（server 支持后）；
- 支持 tombstone 传播，避免“删不掉又被 pull 回来”。

### 18.3 召回可解释性

- 给 relevant selection 记录简短“命中理由”元数据（仅内部调试可见）；
- 便于定位误召回与漏召回。

### 18.4 测试增强

重点补齐：

- gate 组合回归；
- symlink/dangling symlink 攻击样例；
- compact 边界（tool_use/tool_result + thinking 分片）；
- team sync conflict + batch + 413 连续场景。

---

## 十九、建议的源码阅读路线（深度实操版）

1. 先读 `src/memdir/paths.ts`：理解“开关与路径主干”  
2. 再读 `src/memdir/memoryTypes.ts`：理解“存什么/不存什么”的内容策略  
3. 读 `src/memdir/memdir.ts`：理解“系统提示词中的记忆规范”  
4. 读 `src/utils/claudemd.ts`：理解“CLAUDE.md 体系如何并入上下文”  
5. 读 `src/memdir/memoryScan.ts` + `findRelevantMemories.ts`：理解“召回算法”  
6. 读 `src/utils/attachments.ts`：理解“每轮预取与注入、去重与预算”  
7. 读 `src/services/extractMemories/extractMemories.ts`：理解“后台抽取状态机”  
8. 读 `src/services/SessionMemory/sessionMemory.ts`：理解“会话笔记更新”  
9. 读 `src/services/compact/sessionMemoryCompact.ts`：理解“compact 不变量保护”  
10. 读 `src/memdir/teamMemPaths.ts`：理解“路径安全边界”  
11. 读 `src/services/teamMemorySync/index.ts`：理解“同步协议与冲突处理”  
12. 读 `src/services/teamMemorySync/watcher.ts`：理解“运行时触发与节流”  
13. 读 `src/tools/AgentTool/agentMemory.ts`：理解“子代理记忆的并行体系”。

---

## 二十、结论

`D:\work\claude-code-source` 的记忆系统已经具备“生产级复杂度”特征：  
它不是简单的“把文本写到 MEMORY.md”，而是围绕**长期记忆价值、上下文成本、并发一致性、安全边界、协作同步**做了一整套工程化落地。

如果只用一句话总结其架构哲学：

**“规则常驻、内容分层、按需召回、后台沉淀、会话桥接、团队同步，并在每个环节设置可观测与可回退的安全护栏。”**

---

如果你要，我下一步可以直接给你输出第二篇配套文档：  
`《Claude Code 记忆系统时序图与状态机文档》`，包含：

- 启动时序图（init 到 watcher）
- 单轮会话时序图（prefetch、query、stopHook、extract）
- TeamMem push 冲突状态机
- SessionMemory compact 决策树

可直接落到你仓库的 `docs/` 目录格式。

---

