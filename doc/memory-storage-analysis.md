# Claude Code 记忆存储机制 深度分析

## 一、整体架构

Claude Code 的记忆系统是一个多层级的持久化系统，由四个独立的子系统组成，每个子系统有自己的存储位置、触发机制和用途场景:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       记忆存储层次                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Auto Memory (自动记忆, 主对话线程)                                 │
│    ├─ 存储位置: ~/.claude/projects/<sanitized-cwd>/memory/                     │
│    ├─ 入口文件: MEMORY.md + 主题 .md 文件                                  │
│    ├─ 四种类型: user / feedback / project / reference                            │
│    └─ 触发: 主线程主动保存 + 后台 extractMemories forked agent              │
│                                                                      │
│  2. Team Memory (团队记忆, 多人共享)                                │
│    ├─ 存储位置: <autoMemPath>/team/                                     │
│    ├─ 入口文件: MEMORY.md + 主题 .md 文件                                  │
│    ├─ 同步: 本地文件 ↔ 远程服务器 (OAuth + GitHub repo scope)            │
│    └─ 触发: fs.watch 文件变化 → debounce push + 启动时 pull                 │
│                                                                      │
│  3. Agent Memory (代理记忆, 每个 agent 独立)                               │
│    ├─ 存储位置: 三种 scope (user / project / local)                      │
│    ├─ 入口文件: MEMORY.md + 主题 .md 文件                                  │
│    └─ 触发: agent 启动时加载, 代理运行中保存                        │
│                                                                      │
│  4. Session Memory (会话记忆, 单次会话)                               │
│    ├─ 存储位置: ~/.claude/projects/<sanitized-cwd>/<session-id>/session-memory/ │
│    ├─ 入口文件: summary.md                                          │
│    └─ 觾发: postSamplingHook → forked agent (后台提取)                  │
│    └─ 用途: 上下文压缩时的摘要来源 (见前文)                               │
│                                                                      │
│  5. Auto Dream (后台记忆整合)                                          │
│    ├─ 基于 auto memory 目录                                                 │
│    ├─ 触发: stopHook, 三重门控 (时间 + 会话数 + 锁)                     │
│    └─ 用途: 整理旧记忆, 合并重复, 修剪过期                              │
│                                                                      │
│  6. Memory Recall (查询时相关记忆检索)                                 │
│    ├─ 基于 auto memory 目录                                                 │
│    ├─ 触发: 每次用户查询时 (sideQuery 到 Sonnet)                              │
│    └─ 用途: 从已有记忆文件中检索与当前查询相关的记忆                        │
│                                                                      │
│  7. CLAUDE.md (用户/项目指令文件, 非记忆)                               │
│    ├─ 存储位置: 多处 (project / user / local)                              │
│    └─ 不属于记忆系统, 但是会与 memory MEMORY.md 共享 claudemd.ts 加载逻辑           │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 二、目录结构详解

### 2.1 Auto Memory 目录

```
~/.claude/                          ← Claude Code 配置根目录
├── projects/                       ← 按项目隔离
│   └── -Users-wrr-myproject/       ← 项目目录 (cwd 的 sanitized 形式)
│       ├── memory/                  ← Auto Memory 根目录
│       │   ├── MEMORY.md              ← 簿引入口 (索引文件, 每次会话加载)
│       │   ├── user_role.md            ← 单条记忆文件 (带 frontmatter)
│       │   ├── feedback_testing.md
│       │   ├── project_auth.md
│       │   └── reference_links.md
│       └── team/                     ← Team Memory 目录 (auto memory 子目录)
│           ├── MEMORY.md              ← 团队记忆索引
│           ├── team_conventions.md
│           └── team_api_links.md
├── agent-memory/                   ← Agent Memory (user scope)
│   └── my-agent-type/
│       └── MEMORY.md
```

路径解析规则 (`paths.ts:223-235`):

```
getAutoMemPath():
  优先级:
    1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 猋境变量 (完整路径覆盖)
    2. autoMemoryDirectory 设置项 (policy/flag/local/user settings)
    3. <memoryBase>/projects/<sanitized-git-root>/memory/
  memoryBase:
    优先级:
      1. CLAUDE_CODE_REMOTE_MEMORY_DIR 繮境变量
      2. ~/.claude (默认)
  特殊处理:
    - findCanonicalGitRoot() 知找 git 仓库根目录
    - 同一个 repo 的所有 worktree 共享一个 auto memory 目录
    - sanitizePath() 处理路径中的特殊字符
```

### 2.2 Agent Memory 目录

三种 scope (`agentMemory.ts:52-65`):

| scope | 路径 | 说明 |
|-------|------|------|
| user | `~/.claude/agent-memory/<agentType>/` | 茉续项目通用, 茉人级 |
| project | `<cwd>/.claude/agent-memory/<agentType>/` | 项目级, 可提交到 VCS |
| local | `<cwd>/.claude/agent-memory-local/<agentType>/` | 项目级, 不提交到 VCS |

当设置 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 时, local scope 会被重定向到远程存储。

### 2.3 Session Memory 目录

```
~/.claude/projects/<sanitized-cwd>/<session-id>/
├── transcript.json               ← 对话记录
└── session-memory/
    └── summary.md              ← 会话记忆笔记文件
```

(注: Session Memory 详见《上下文压缩机制 深度分析"文档)

## 三、记忆文件格式

### 3.1 单条记忆文件 (Topic File)

每个记忆文件使用 YAML frontmatter + markdown 正文格式:

```markdown
---
name: 用户角色和偏好
description: 用户是数据科学家, 关注可观测性和日志, 有 Go 经验但 React 新手
type: user
---

用户是数据科学家, 目前专注于 observability/logging 域域。 有 10 年 Go 经验, 最近开始接触 React 前端。
解释前端概念时倾向于用后端类比。

**Why:** 从用户自我介绍中得知
**How to apply:** 调整技术解释的深度和角度
```

### 3.2 Frontmatter 字段

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| name | string | 是 | 记忆名称 |
| description | string | 是 | 一行描述, 用于判断相关性 |
| type | enum | 是 | user / feedback / project / reference |

### 3.3 入口文件 MEMORY.md

MEMORY.md 是纯 markdown 索引文件 (无 frontmatter), 每条记录一行:

```markdown
- [用户角色和偏好](user_role.md) — 数据科学家, 有 Go 经验, React 新手
- [测试策略](feedback_testing.md) — 集成测试必须真实数据库, 不用 mock
- [认证中间件重写](project_auth.md) — 合规驱动的重写, 非 tech-debt
```

**限制**:
- 最多 200 行 (`MAX_ENTRYPOINT_LINES`)
- 最大 25KB (`MAX_ENTRYPOINT_BYTES`)
- 超过限制时追加 WARNING 揇示

### 3.2 四种记忆类型

| 类型 | scope (combined 模式) | 说明 | 保存时机 |
|------|----------------------|------|----------|
| user | always private | 用户角色、偏好、知识、能力 | 了解用户信息时 |
| feedback | default private, 项目级约定可 team | 用户纠正和确认的工作方式 | 被纠正或确认时 |
| project | bias toward team | 项目上下文 (非代码可得的) | 了解项目动态时 |
| reference | usually team | 外部系统指针 (Dashboard, Slack 等) | 发现外部资源时 |

### 3.3 记忆扫描

`scanMemoryFiles()` (`memoryScan.ts:35`) 扫描记忆目录:

1. 递归读取所有 `.md` 文件 (排除 MEMORY.md)
2. 读取每个文件的前 30 行 frontmatter
3. 解析 frontmatter 获取 name, description, type
4. 按 mtimeMs 降序排列, 取最新 200 条
5. 返回 `MemoryHeader[]` 列表

## 四、六大子系统详解

### 4.1 Auto Memory (自动记忆)

#### 4.1.1 记忆写入

**两条写入路径** (互斥):

**路径 A: 主线程主动写入**
- 主对话中的模型根据 system prompt 中的记忆指令, 直接使用 Write/Edit 工具保存记忆
- 这是最直接的路径, 模型看到完整对话上下文

**路径 B: 后台 ExtractMemories forked agent**
- 当主线程没有写入记忆时, 触发后台 forked agent
- 使用 `runForkedAgent()` 创建主对话的完美 fork
- Agent 看到完整对话历史 + 记忆指令, 自主决定保存什么
- 工具限制: 只能 Read/Grep/Glob + 只读 Bash + 只能写入 memory 目录
- Turn 限制: 最多 5 turns
- 互斥保证: `hasMemoryWritesSince()` 检查主线程是否已写入记忆

**触发时机**:
- 在 `stopHooks.ts` 中注册, 每轮对话结束后触发
- 频率控制: `tengu_bramble_lintel` feature flag (默认每轮)
- 互斥: 主线程写入 → 后台 agent 跳过 → 渐进 cursor

**关闭时清理**:
- `drainPendingExtraction()` 等待进行中的提取完成
- 超时: 60 秒
- 在 `print.ts` 响应输出后、关闭前调用

#### 4.1.2 记忆加载

**系统提示加载** (`memdir.ts:419 loadMemoryPrompt()`):

```
loadMemoryPrompt()
    │
    ├─ isAutoMemoryEnabled()?  → 不启用则返回 null
    │
    ├─ KAIROS 模式?  → buildAssistantDailyLogPrompt() (append-only 日志)
    │
    ├─ Team Memory 启用?  → buildCombinedMemoryPrompt() (双目录)
    │
    └─ Auto Memory only  → buildMemoryLines() (单目录)
        │
        ├─ 构建行为指令 (类型/保存方式/访问方式/信任验证)
        ├─ 读取 MEMORY.md 内容
        ├─ truncateEntrypointContent() (200行/25KB 限制)
        └─ 拼接成完整 prompt
```

**三种 prompt 模式**:

| 模式 | 条件 | 特点 |
|------|------|------|
| 标准 (单目录) | 仅 auto memory | MEMORY.md 索引 + 主题文件 |
| 组合 (双目录) | auto + team memory | 两个 MEMORY.md, 私有 + 团队目录 |
| 日志 (KAIROS) | 助手模式, 长期运行 | 追加写入日志文件, 夜间 /dream 整合 |

#### 4.1.3 记忆内容注入

记忆内容通过 `claudemd.ts` 的 `getMemoryFiles()` 加载到系统提示中:

```
claudemd.ts getMemoryFiles()
    │
    ├─ 发现 auto memory 目录下的所有 .md 文件
    ├─ MEMORY.md → 作为 system prompt 的一部分直接加载
    │   ├─ 200 行上限 + 25KB 上限
    │   └─ 超过限制时追加 WARNING
    │
    └─ 其他 .md 文件 → 不直接加载, 需要时通过 Recall 检索
```

#### 4.1.4 记忆检索 (Memory Recall)

**触发**: 每次用户发送查询时 (`findRelevantMemories.ts`)

```
findRelevantMemories(query, memoryDir, signal, recentTools, alreadySurfaced)
    │
    ├─ scanMemoryFiles() → 扫描所有记忆文件头信息
    │   ├─ 读取 frontmatter (name, description, type)
    │   └─ 按修改时间排序, 取最新 200 条
    │
    ├─ 过滤已展示过的记忆 (alreadySurfaced)
    │
    └─ selectRelevantMemories()
        ├─ 使用 Sonnet 模型 (sideQuery)
        ├─ 输入: 查询文本 + 记忆文件列表 (manifest)
        ├─ 输出: JSON {selected_memories: [filename, ...]}
        ├─ 最多选 5 个
        └─ 过滤掉已使用的工具对应的参考文档
```

**检索结果处理**:
- 通过 `wrapMessagesInSystemReminder()` 包装为 system-reminder 消息
- 包含记忆内容 + 新鲜度警告 (`memoryFreshnessNote`)
- >1 天的记忆会附带"可能过时"警告

### 4.2 Team Memory (团队记忆)

#### 4.2.1 启用条件

```
isTeamMemoryEnabled() = isAutoMemoryEnabled() && feature flag 'tengu_herring_clock'
isTeamMemorySyncAvailable() = isFirstPartyOAuth() && github.com remote
```

#### 4.2.2 目录位置

Team Memory 是 Auto Memory 的子目录:

```
getTeamMemPath() = join(getAutoMemPath(), 'team') + sep
```

即: `~/.claude/projects/<sanitized-cwd>/memory/team/`

#### 4.2.3 同步机制

**服务器 API**:
```
GET  /api/claude_code/team_memory?repo={owner/repo}            → 获取所有条目
GET  /api/claude_code/team_memory?repo={owner/repo}&view=hashes → 仅获取校验和
PUT  /api/claude_code/team_memory?repo={owner/repo}            → 上传条目 (upsert)
```

**同步语义**:
- Pull: 服务器内容覆盖本地 (server wins)
- Push: 只上传内容哈希不同的条目 (delta upload)
- 删除不会传播: 删除本地文件不会删除服务器上的, 下次 pull 会恢复
- 冲突解决: 412 时 probe 获取最新 hashes → 重算 delta → 最多重试 2 次

**文件监控** (`watcher.ts`):

```
startTeamMemoryWatcher()
    │
    ├─ 前置检查: TEAMMEM feature + isTeamMemoryEnabled + OAuth + github.com remote
    │
    ├─ pullTeamMemory() → 从服务器拉取最新内容
    │   ├─ 条件请求 (If-None-Match / ETag)
    │   ├─ 304 Not Modified → 跳过
    │   └─ 200 → 写入本地文件 (跳过内容相同的)
    │
    └─ startFileWatcher(teamDir) → 监控文件变化
        ├─ fs.watch({recursive: true})
        ├─ 文件变化 → schedulePush()
        │   ├─ 2s debounce (避免频繁推送)
        │   └─ executePush()
        │       ├─ readLocalTeamMemory() → 读取本地所有文件
        │       │   ├─ scanForSecrets() → 跳过含敏感信息的文件 (PSR M22174)
        │       │   └─ 按 serverMaxEntries 截断 (如果已知)
        │       ├─ 计算本地文件 hash
        │       ├─ 与 serverChecksums 比较 → 计算 delta
        │       ├─ batchDeltaByBytes() → 按 200KB 分批
        │       └─ 逐批 uploadTeamMemory()
        │           ├─ If-Match ETag → 乐观锁
        │           ├─ 412 → probe hashes → 重算 delta → 重试
        │           └─ 413 (too many entries) → 学习 serverMaxEntries
        └─ pushSuppressedReason: 永久性失败时抑制推送
```

**安全措施**:
- `validateTeamMemKey()`: 路径遍历检测 (null byte, URL encode, Unicode normalize, symlink escape)
- `realpathDeepestExisting()`: 解析 symlink 到真实路径
- `scanForSecrets()`: gitleaks 规则扫描敏感信息, 跳过含 secret 的文件
- 单文件大小限制: 250KB (`MAX_FILE_SIZE_BYTES`)

### 4.3 Agent Memory (代理记忆)

#### 4.3.1 三种 Scope

| Scope | 路径 | 共享范围 |
|-------|------|----------|
| user | `~/.claude/agent-memory/<agentType>/` | 跨项目, 跨会话, 仅限当前用户 |
| project | `<cwd>/.claude/agent-memory/<agentType>/` | 项目级, 可通过 VCS 共享 |
| local | `<cwd>/.claude/agent-memory-local/<agentType>/` | 项目级, 不通过 VCS |

#### 4.3.2 加载和保存

```
loadAgentMemoryPrompt(agentType, scope)
    │
    ├─ getAgentMemoryDir(agentType, scope) → 计算目录路径
    ├─ ensureMemoryDirExists(memoryDir) → 确保目录存在 (fire-and-forget)
    └─ buildMemoryPrompt({displayName, memoryDir, extraGuidelines})
        ├─ 记忆行为指令 (同 auto memory 的四类型)
        ├─ 读取 MEMORY.md 内容
        └─ 拼接成完整 prompt
```

- Prompt 格式与 auto memory 完全相同 (四类型体系 + frontmatter)
- 额外 scope 提示: user → 跨项目通用; project → 项目特定; local → 本机特定
- 权限: 写入 auto memory 路径自动允许 (`isAutoMemPath` 写入豁免)
- 权限: 写入 agent memory 路径自动允许 (`isAgentMemoryPath` 写入豁免)

### 4.4 Auto Dream (后台记忆整合)

#### 4.4.1 触发条件

三重门控 (`autoDream.ts`):

```
executeAutoDream()
    │
    ├─ Gate 1: isGateOpen()
    │   ├─ !KAIROS (KAIROS 使用自己的 /dream skill)
    │   ├─ !remote mode
    │   ├─ isAutoMemoryEnabled()
    │   └─ isAutoDreamEnabled() (feature flag)
    │
    ├─ Gate 2: Time Gate
    │   └─ hoursSince >= minHours (默认 24 小时)
    │
    ├─ Gate 3: Session Gate
    │   ├─ listSessionsTouchedSince(lastAt)
    │   ├─ 排除当前会话
    │   └─ sessionIds.length >= minSessions (默认 5 个)
    │
    ├─ Lock: tryAcquireConsolidationLock()
    │   └─ 原子性保证, 防止多进程同时整合
    │
    └─ runForkedAgent()
        ├─ prompt: 4-phase consolidation (Orient → Gather → Consolidate → Prune)
        ├─ 工具限制: 同 extractMemories (只读 + memory 目录写入)
        └─ 结果: 更新/合并/删除记忆文件 + MEMORY.md 索引
```

**配置** (`tengu_onyx_plover` GrowthBook):

| 配置项 | 默认值 | 说明 |
|-------|-------|------|
| minHours | 24 | 距上次整合的最小小时数 |
| minSessions | 5 | 最少积累的会话数 |

**Consolidation Lock** (`consolidationLock.ts`):
- 使用文件锁 (`~/.claude/projects/<slug>/memory/.consolidation-lock`) 保证原子性
- lock 文件的 mtime 记录上次整合时间
- 支持回滚 (失败时恢复之前的 mtime)

#### 4.4.2 整合流程 (4-phase)

```
Phase 1: Orient (定位)
    ├─ ls memory 目录
    ├─ 读 MEMORY.md 索引
    └─ 浏览已有主题文件

Phase 2: Gather (收集)
    ├─ 读日志文件 (logs/YYYY/MM/YYYY-MM-DD.md)
    ├─ 检查已过时的记忆
    └─ 按需 grep 会话记录 (narrow terms)

Phase 3: Consolidate (整合)
    ├─ 写入/更新主题文件
    ├─ 合并新信息到已有文件
    └─ 删除被证伪的事实

Phase 4: Prune (修剪)
    ├─ 更新 MEMORY.md 索引
    ├─ 删除过期/错误的指针
    └─ 确保索引不超过 200 行 / 25KB
```

### 4.5 记忆检索 (Memory Recall)

```
用户查询 → findRelevantMemories()
    │
    ├─ scanMemoryFiles(memoryDir)
    │   ├─ 递归读取 .md 文件 (排除 MEMORY.md)
    │   ├─ 读取前 30 行 frontmatter
    │   └─ 按修改时间排序, 取最新 200 条
    │
    ├─ 过滤已展示过的记忆
    │
    └─ sideQuery(Sonnet, manifest + query)
        ├─ system prompt: "选择对当前查询有用的记忆"
        ├─ input: 查询文本 + 记忆文件列表 + 最近使用的工具
        ├─ structured output: {selected_memories: [filenames]}
        └─ 最多返回 5 个记忆文件
```

**新鲜度标记** (`memoryAge.ts`):
- <= 1 天: 无警告
- > 1 天: 追加 "This memory is N days old. ... claims about code behavior or file:line citations may be outdated."

## 五、记忆与 System Prompt 的集成

### 5.1 加载位置

记忆通过 `claudemd.ts` 的 `getMemoryFiles()` 加载, 该函数收集所有 "Claude markdown" 文件:

```
getMemoryFiles()
    │
    ├─ CLAUDE.md files (用户指令文件)
    │   ├─ ~/.claude/CLAUDE.md (user)
    │   ├─ <project>/.claude/CLAUDE.md (project, 可递归)
    │   └─ <project>/CLAUDE.md (root)
    │
    └─ Memory files (自动记忆)
        ├─ <autoMemPath>/CLAUDE.md → symlink to MEMORY.md
        └─ <autoMemPath>/*.md → 其他记忆文件 (不直接加载)
```

**关键点**: 只有 MEMORY.md (通过 symlink CLAUDE.md) 被加载到系统提示。其他主题文件需要通过 Recall 机制按需加载。

### 5.2 记忆文件的权限处理

记忆文件路径在文件系统权限层有特殊处理 (`filesystem.ts`):

- **读取**: `isAutoMemPath()` / `isAgentMemoryPath()` 匹配 → 自动允许 (无需权限确认)
- **写入**:
  - 非 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 时: `isAutoMemPath()` 匹配 → 自动允许 (跳过 DANGEROUS_DIRECTORIES 检查, 因为默认路径在 ~/.claude/ 下)
  - 使用 override 时: 正常权限流程 (不自动允许)
  - `isAgentMemoryPath()` 匹配 → 自动允许

## 六、环境变量与配置

### 6.1 启用/禁用

| 变量 | 作用 |
|------|------|
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 设为 1/true 禁用所有自动记忆功能 |
| `CLAUDE_CODE_SIMPLE` | --bare 模式, 禁用记忆 |
| `CLAUDE_CODE_REMOTE` | 远程模式, 无 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 时禁用 |
| `ENABLE_CLAUDE_CODE_SM_COMPACT` | 强制启用 session memory 压缩 |
| `DISABLE_CLAUDE_CODE_SM_COMPACT` | 强制禁用 session memory 压缩 |

### 6.2 路径覆盖

| 变量 | 作用 |
|------|------|
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | 覆盖 auto memory 完整路径 (Cowork/SDK 用) |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | 覆盖记忆基础目录 (CCR 远程模式) |
| `autoMemoryDirectory` (settings.json) | 覆盖 auto memory 目录 (支持 ~/ 展开, 仅限 trusted sources) |

### 6.3 GrowthBook Feature Flags

| Flag | 默认 | 说明 |
|------|------|------|
| `tengu_passport_quail` | false | 启用后台 extractMemories agent |
| `tengu_bramble_lintel` | 1 | extractMemories 每几轮触发一次 |
| `tengu_herring_clock` | false | 启用 team memory |
| `tengu_onyx_plover` | null | auto dream 配置 (minHours, minSessions) |
| `tengu_coral_fern` | false | 启用 "Searching past context" 提示 (grep 历史 transcript) |
| `tengu_moth_copse` | false | 跳过 MEMORY.md 索引步骤 (直接写主题文件) |

### 6.4 settings.json

| 配置项 | 说明 |
|-------|------|
| `autoMemoryEnabled` | 启用/禁用自动记忆 (支持项目级覆盖) |
| `autoMemoryDirectory` | 覆盖 auto memory 目录 (不支持 projectSettings) |

## 七、设计亮点与权衡

1. **双层写入保证**: 主线程可以直接写记忆 (最准确的上下文), 后台 agent 补充遗漏 (互斥, 不重复)

2. **Token 预算控制**: MEMORY.md 200行/25KB 硬上限 + 每个主题文件 250KB 上限; 防止记忆文件膨胀消耗上下文

3. **记忆新鲜度**: 通过 mtime 追踪, >1天的记忆自动附上过时警告; 模型被提醒验证后再使用

4. **安全纵深**:
   - 路径遍历防护 (null byte, URL encode, Unicode, symlink)
   - Team memory 敏感信息扫描 (gitleaks 规则)
   - settings.json 覆盖只允许 trusted sources (防止恶意 repo 设置)

5. **增量同步**: Team memory 使用 per-key hash delta + ETag 乐观锁, 不做全量上传

6. **记忆整合**: Auto Dream 定期整合记忆 (合并重复, 删除过时), 防止记忆文件无限增长

7. **上下文效率**: MEMORY.md 索引始终加载 (小), 主题文件按需加载 (最多5个), 避免一次性加载所有记忆

8. **Git worktree 共享**: 使用 findCanonicalGitRoot(), 同一 repo 的不同 worktree 共享一个记忆目录

9. **KAIROS 助手模式**: 长期运行的会话使用 append-only 日志 (不维护索引), 夜间 /dream 整合

## 八、核心文件索引

| 文件路径 | 职责 |
|---------|------|
| `src/memdir/memdir.ts` | 记忆 prompt 构建 (单目录/组合/日志), MEMORY.md 加载, 入口截断 |
| `src/memdir/paths.ts` | 路径解析 (auto memory / memory base), 启用检查, 路径验证 |
| `src/memdir/memoryTypes.ts` | 四种记忆类型定义, prompt 模板 (类型/保存/访问/信任) |
| `src/memdir/memoryScan.ts` | 记忆文件扫描 (frontmatter 解析, 按时间排序) |
| `src/memdir/memoryAge.ts` | 记忆新鲜度计算 (天数, 过时警告文本) |
| `src/memdir/findRelevantMemories.ts` | 记忆检索 (Sonnet sideQuery, 最多5个相关记忆) |
| `src/memdir/teamMemPaths.ts` | Team memory 路径, 启用检查, 路径安全验证 |
| `src/memdir/teamMemPrompts.ts` | Team memory 组合 prompt 构建 |
| `src/services/extractMemories/extractMemories.ts` | 后台记忆提取 forked agent (互斥, cursor, trailing run) |
| `src/services/extractMemories/prompts.ts` | 记忆提取 prompt 模板 |
| `src/services/autoDream/autoDream.ts` | 后台记忆整合 (三重门控, consolidation lock) |
| `src/services/autoDream/consolidationPrompt.ts` | 整合 prompt (4-phase: Orient/Gather/Consolidate/Prune) |
| `src/services/autoDream/consolidationLock.ts` | 整合锁 (文件锁, mtime 记录) |
| `src/services/teamMemorySync/index.ts` | Team memory 同步 (pull/push, delta, ETag, conflict) |
| `src/services/teamMemorySync/watcher.ts` | Team memory 文件监控 (fs.watch, debounce push) |
| `src/tools/AgentTool/agentMemory.ts` | Agent memory 路径, 加载, scope 处理 |
| `src/utils/memoryFileDetection.ts` | 记忆文件检测 (auto/team/session scope) |
| `src/utils/claudemd.ts` | Claude markdown 文件收集 (CLAUDE.md + MEMORY.md symlink) |
| `src/utils/permissions/filesystem.ts` | 记忆文件权限豁免 (读写自动允许) |
