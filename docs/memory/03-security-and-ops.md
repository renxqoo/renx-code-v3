# 分册 03：安全模型与运维契约

> **节选来源**：[claude-code-memory-system-deep-analysis.md](./claude-code-memory-system-deep-analysis.md)  
> **分析源码树**：`D:\work\claude-code-source`  
> **本册对应合订本章节**：五十、运维与契约补充（生产可落地版）。

### 源码侧可对照模块

- 路径与 team key 校验：`src/memdir/paths.ts`、`src/memdir/teamMemPaths.ts`
- 团队记忆写前与推送前敏感信息：`src/services/teamMemorySync/teamMemSecretGuard.ts`、推送路径中的 secret 扫描逻辑
- 同步与 watcher：`src/services/teamMemorySync/index.ts`、`src/services/teamMemorySync/watcher.ts`

---

## 五十、运维与契约补充（生产可落地版）

> 本章补齐“代码有实现但文档易缺失”的部分：gate 矩阵、配置优先级、API 契约、攻击树、Runbook、事件字典与回归索引。  
> 目标是让该文档不仅能“读懂系统”，还能直接用于排障、上线评审与交接。

### 50.1 Feature Gate 全景矩阵

| Gate / 条件 | 作用模块 | 开启后行为 | 关闭后行为 | 代码锚点 |
|---|---|---|---|---|
| `tengu_passport_quail` | ExtractMemories | 回合后允许抽取 fork | 不执行 extract | `memdir/paths.ts:isExtractModeActive`, `services/extractMemories/extractMemories.ts` |
| `tengu_slate_thimble` | ExtractMemories（非交互） | 非交互会话也可抽取 | 非交互禁用抽取 | `memdir/paths.ts:isExtractModeActive` |
| `tengu_moth_copse` | Memory 索引注入策略 | 偏向 relevant memories 预取/附件 | 常规索引注入路径 | `memdir/memdir.ts`, `utils/claudemd.ts`, `utils/attachments.ts` |
| `tengu_herring_clock` | TEAMMEM | 启用 team memory 目录与逻辑 | team memory 全链路关闭 | `memdir/teamMemPaths.ts:isTeamMemoryEnabled` |
| `tengu_session_memory` | SessionMemory | 启用会话记忆更新 | 只走传统路径 | `services/SessionMemory/sessionMemory.ts` |
| `tengu_sm_compact` | SessionMemoryCompact | compact 优先尝试 session memory | fallback legacy compact | `services/compact/sessionMemoryCompact.ts` |
| `tengu_onyx_plover` | AutoDream | 控制 dream 的 minHours/minSessions | 使用默认阈值或不触发 | `services/autoDream/autoDream.ts` |
| `KAIROS`（build/runtime） | Memdir 模式切换 | 走 daily log append-only | 走常规 memory index/topic | `memdir/memdir.ts:buildAssistantDailyLogPrompt` |

补充：除 gate 外，以下硬条件也会强制关闭能力：

- `CLAUDE_CODE_SIMPLE=true`（关闭 auto-memory 周边能力）
- remote 模式无持久 memory dir
- TeamSync 无 OAuth / 无 GitHub repo

---

### 50.2 配置优先级矩阵（env > settings > default）

#### 50.2.1 AutoMemory 总开关优先级

1. `CLAUDE_CODE_DISABLE_AUTO_MEMORY`（显式 true/false）
2. `CLAUDE_CODE_SIMPLE`
3. remote + `CLAUDE_CODE_REMOTE_MEMORY_DIR` 约束
4. `settings.autoMemoryEnabled`
5. 默认 true

#### 50.2.2 AutoMemory 路径优先级

1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`
2. `settings.autoMemoryDirectory`（受信来源）
3. `<memoryBase>/projects/<sanitize(gitRoot)>/memory/`

#### 50.2.3 TeamMemory 启动条件

同时满足：

- TEAMMEM feature/build 存在
- `isAutoMemoryEnabled()==true`
- `isTeamMemoryEnabled()==true`（gate）
- OAuth 可用（first-party）
- repo slug 可解析（GitHub remote）

---

### 50.3 TeamMemory API 契约与状态码语义

#### 50.3.1 端点契约

- `GET /api/claude_code/team_memory?repo=<slug>`
  - 200: 返回 content + checksum + entryChecksums
  - 304: not modified（带 If-None-Match）
  - 404: 远端无数据
- `GET ...&view=hashes`
  - 200: 只返回哈希元数据（冲突重试探针）
  - 404: 远端空
- `PUT /api/claude_code/team_memory?repo=<slug>`
  - 200: upsert 成功
  - 412: If-Match 冲突（需刷新 hashes 重算 delta）
  - 413: payload/entry limit 超限（可能带结构化 max_entries）

#### 50.3.2 客户端行为语义

| 状态码 | 客户端动作 | 是否重试 |
|---|---|---|
| 200 | 更新 `lastKnownChecksum`，提交成功 | 否 |
| 304 | 视为无变化 | 否 |
| 404 | 视为远端空，清空 serverChecksums | 否 |
| 412 | `fetchTeamMemoryHashes` 后重算 delta | 是（有限） |
| 413 | 记录限制信息，必要时学习 `serverMaxEntries` | 否（当前调用） |

---

### 50.4 安全攻击树与防线映射

#### 50.4.1 攻击树 A：路径逃逸（Path Traversal / Symlink Escape）

- 攻击路径：
  - `..` 穿越
  - URL 编码穿越
  - Unicode 归一化绕过
  - dangling symlink 指向外部
  - symlink loop

- 防线函数：
  - `sanitizePathKey`
  - `validateTeamMemKey`
  - `validateTeamMemWritePath`
  - `realpathDeepestExisting`
  - `isRealPathWithinTeamDir`

#### 50.4.2 攻击树 B：敏感信息扩散

- 攻击路径：模型误写 key/credential 到 team memory -> push 同步扩散
- 防线函数：
  - 写前校验：`checkTeamMemSecrets`
  - push 前校验：`scanForSecrets`（命中即跳过该文件）

#### 50.4.3 攻击树 C：后台代理越权

- 攻击路径：extract/session/dream 代理调用非授权工具修改仓库
- 防线函数：
  - `createAutoMemCanUseTool`
  - `createMemoryFileCanUseTool`
  - Bash read-only 判定

---

### 50.5 运行手册（Runbook）

#### 50.5.1 症状：记忆没有自动更新

排查顺序：
1. 看 `isAutoMemoryEnabled` 相关配置（env/settings）
2. 看 extract gate（`tengu_passport_quail`）
3. 检查是否“主代理已写 memory 导致 extract skip”
4. 看 `tengu_extract_memories_*` 事件是否有错误

修复动作：
- 调整 gate/配置；
- 检查 memory 目录权限；
- 对抽取失败看 `canUseTool` deny 原因。

#### 50.5.2 症状：TeamMemory 一直不上传

排查顺序：
1. OAuth 是否有效（first-party + scopes）
2. repo slug 是否存在（GitHub remote）
3. watcher 是否 suppression（`tengu_team_mem_push_suppressed`）
4. 是否 413/冲突循环

修复动作：
- 处理认证或 remote 配置；
- 减少超大文件/超多 entry；
- 清理触发冲突的热点 key。

#### 50.5.3 症状：compact 后对话行为异常

排查顺序：
1. session memory 是否为空模板
2. 是否走了 `trySessionMemoryCompaction` 或 fallback
3. 检查 `adjustIndexToPreserveAPIInvariants` 相关回归

修复动作：
- 增加边界测试 fixture；
- 核查 tool_use/tool_result 保留链。

---

### 50.6 Telemetry 事件字典（精选）

| 事件名 | 触发时机 | 关键字段 |
|---|---|---|
| `tengu_memdir_loaded` | memory prompt 加载目录统计 | `total_file_count`, `total_subdir_count`, `memory_type` |
| `tengu_extract_memories_extraction` | extract fork 完成 | token usage, `files_written`, `memories_saved`, `duration_ms` |
| `tengu_extract_memories_skipped_direct_write` | 主链写入导致跳过 | `message_count` |
| `tengu_session_memory_extraction` | session memory 自动更新 | usage + config 阈值字段 |
| `tengu_sm_compact_flag_check` | compact 决策检查 | `tengu_session_memory`, `tengu_sm_compact`, `should_use` |
| `tengu_team_mem_sync_pull` | team pull | success/not_modified/files_written/status |
| `tengu_team_mem_sync_push` | team push | success/conflict/conflict_retries/files_uploaded/status |
| `tengu_team_mem_secret_skipped` | push 前 secret 命中 | `file_count`, `rule_ids` |
| `tengu_team_mem_push_suppressed` | watcher 熔断 | `reason`, `status` |

---

### 50.7 回归测试最小覆盖索引（函数 -> 必测点）

| 函数 | 必测点 |
|---|---|
| `isAutoMemoryEnabled` | env 覆盖优先级、SIMPLE 分支、remote 分支 |
| `validateMemoryPath` | `~/` 边界、UNC、盘符根、null byte |
| `truncateEntrypointContent` | 仅行超限、仅字节超限、双超限 |
| `findRelevantMemories` | selector 异常回退、unknown filename 过滤 |
| `startRelevantMemoryPrefetch` | abort 生命周期、单词输入短路 |
| `createAutoMemCanUseTool` | bash 非只读拒绝、非 memory 路径写拒绝 |
| `runExtraction` | 主写互斥、pending trailing、throttle 分支 |
| `shouldExtractMemory` | token/tool 双阈值组合 |
| `adjustIndexToPreserveAPIInvariants` | orphan tool_result 修复、同 message.id 分片修复 |
| `pushTeamMemory` | 412 收敛路径、413 限额路径、secret skip 路径 |
| `writeRemoteEntriesToLocal` | unchanged skip、路径校验失败跳过 |

---

### 50.8 文档维护建议（避免后续过期）

建议每次改动以下文件时同步更新本章：

- `src/memdir/paths.ts` / `memdir.ts`
- `src/services/extractMemories/extractMemories.ts`
- `src/services/SessionMemory/*`
- `src/services/compact/sessionMemoryCompact.ts`
- `src/services/teamMemorySync/*`

并在 PR 模板加入一项复选：

- [ ] 已更新 `docs/memory/claude-code-memory-system-deep-analysis.md` 的 gate/契约/runbook 变更

---

