# `@renx/agent` 记忆子系统（`src/memory`）使用说明

本目录实现 Agent 的**持久化记忆**：工作区快照、语义条目、会话片段、多作用域存储、租户策略、自动提取、团队同步与健康检查。对外主入口为 `index.ts`，运行时通常通过 `MemoryService` 与 `MemorySubsystem` 配置接入。

---

## 1. 模块职责一览

| 能力 | 主要符号 | 说明 |
|------|-----------|------|
| 快照规范化与合并 | `createMemorySnapshot`、`mergeMemorySnapshot` | 统一空层结构、合并列表、保留扩展字段 |
| 容量与截断 | `applyMemoryPolicy`、`DEFAULT_MEMORY_POLICY` | 条数上限、单条内容最大字符 |
| 按作用域切片 | `extractScopedMemorySnapshot`、`hasMeaningfulMemory` | 写入管线拆分到 user/project/local |
| 租户/隔离策略 | `applyMemoryTenantPolicy` | 允许的作用域与分类、脱敏、条数覆盖 |
| 治理（脱敏与过期） | `applyMemoryGovernance`、`DEFAULT_MEMORY_GOVERNANCE_CONFIG` | 邮箱/密钥样式替换、语义条目按天过期 |
| 运行时门面 | `MemoryService` | 水合状态、落盘、自动保存、构建提示词中的记忆块 |
| 命令式 CRUD（语义） | `MemoryCommandService` | 基于 `ScopedMemoryStore` 的 save/list/delete/recall |
| 提示内召回 | `recallMemoryEntries`、`MemoryRecallInput` | 按查询词打分 + 回退策略 |
| 自动保存触发 | `shouldAutoSaveMemory`、`buildMemoryAutomationWindow` 等 | 消息数窗口与去重 |
| 快照同步（本地两桶） | `MemorySnapshotSyncService` | 检测源是否更新、初始化或提示更新 |
| 团队远程同步 | `MemoryTeamSyncService`、`MemoryRemoteTransport` | 拉取/推送、冲突重试、密钥条目跳过 |
| 密钥扫描 | `scanMemorySecrets`、`checkSharedMemorySnapshotForSecrets` | 同步前安全检查 |
| 健康检查 | `inspectMemoryHealth` | 预算、策略压力、密钥、同步陈旧度 |
| 分类提示词 | `buildMemoryTaxonomyPrompt`、`parseMemoryTaxonomyType` | 给提取器/模型的说明文本 |
| 写入计划 | `MemoryWritePipeline` | 单次捕获 → 运行快照 + 各作用域子快照 |

---

## 2. 数据模型：`MemorySnapshot`

快照是一个 JSON 可序列化对象，核心分层如下（其余顶层键会作为「附加记忆」原样保留并在 `buildPromptMemory` 中输出）。

### 2.1 `working`（`WorkingMemoryLayer`）

- `recentFiles`：`MemoryRecentFileEntry[]`（`path`、`content?`、`updatedAt`、`scope?`）
- `skills` / `rules`：`MemoryNamedContentEntry[]`（`name`、`path?`、`content?`、`updatedAt`、`scope?`）
- `activePlan`：字符串或任意 JSON
- `hooks`、`mcpInstructions`：可选透传字段

### 2.2 `semantic`（`SemanticMemoryLayer`）

- `entries`：`MemorySemanticEntry[]`
  - 必填：`id`、`content`、`updatedAt`
  - 常用：`title`、`description`、`type`（分类）、`why`、`howToApply`、`tags`、`scope`

**分类 `MemoryTaxonomyType`**：`user` | `feedback` | `project` | `reference`（见 `taxonomy.ts` 与 `MEMORY_TAXONOMY_TYPES`）。

### 2.3 `artifacts`（`ArtifactMemoryLayer`）

- `preservedContextAssets`：与上下文保留资源对齐的结构（含 `id`、`content`、`updatedAt`、`scope?`、`priority?` 等，类型定义在 `../context/types`）。

### 2.4 `session`

- 可选的 `SessionMemoryRecord`，由 `MemoryService.captureState` / `hydrateState` 与 `session-memory` 子系统协作读写。

### 2.5 `automation`（`MemoryAutomationState`）

- `lastAutoSavedMessageId`、`lastAutoSavedAt`：防止对同一条最新消息重复自动提取。

### 2.6 作用域 `MemoryScope`

- `user` | `project` | `local`：用于条目的 `scope` 字段及分桶存储的命名空间解析。

---

## 3. 存储抽象

### 3.1 `MemoryStore`（按 `runId`）

- `load(runId)` / `save(runId, snapshot)`
- 实现：`InMemoryMemoryStore`（测试）、`FileMemoryStore(baseDir)` → `{baseDir}/{runId}.json`

### 3.2 `ScopedMemoryStore`（按 `scope` + `namespace`）

- `load(scope, namespace)` / `save(scope, namespace, snapshot)`
- 实现：`InMemoryScopedMemoryStore`、`FileScopedMemoryStore(baseDir)` → `{baseDir}/{scope}/{encodeURIComponent(namespace)}.json`

### 3.3 `MemorySubsystem`（接入运行时的配置块）

在 `types.ts` 中定义，典型字段：

- `store`：必填，`MemoryStore`
- `scopeStore`：可选，启用多作用域持久化与水合
- `scopeResolver`：可选，`(MemoryScopeContext) => MemoryScopeResolution`；缺省时用 `userId` / `tenantId` / `metadata` 推导命名空间
- `tenantPolicyResolver`：可选，返回 `MemoryTenantPolicy` 做读路径过滤与限额
- `policy`：`Partial<MemoryPolicy>`，覆盖默认容量
- `automation`：`Partial<MemoryAutomationConfig>`
- `governance`：`Partial<MemoryGovernanceConfig>`
- `extractor`：实现 `MemoryExtractor`，供 `maybeAutoSave` 从对话提取语义条目
- `hooks`：`onEvent` 接收 `MemoryEvent`（自动保存、作用域落盘、团队同步等）
- `session`：`SessionMemorySubsystem`（与包内 session 记忆配合）
- `config`：如 `promptTokenBudget`（默认 4000 tokens 估算用于 `buildPromptMemory`）

**默认命名空间解析（无 `scopeResolver` 时）**：

- `user`：`tenantId ? \`${tenantId}:${userId}\` : userId`（需 `userId`）
- `project`：`metadata.projectMemoryKey` → 否则 `projectId` → 否则 `workspaceId`
- `local`：`metadata.localMemoryKey`

---

## 4. `MemoryService` 使用流程

构造：`new MemoryService(subsystem?: MemorySubsystem)`。未传 `subsystem` 时多数写操作为空操作，读仍返回规范化空快照。

### 4.1 水合：`hydrateState(runId, state, scopeContext?)`

合并顺序（后者覆盖前者）：

1. 各作用域快照（若存在 `scopeStore` 与 `scopeContext`）
2. `store.load(runId)`
3. 当前 `state.memory`
4. `applyMemoryTenantPolicy`（若有租户策略）
5. 若快照含 `session`，再 `applySessionMemoryRecordToState`

用于在回合开始前把磁盘/共享记忆灌回 `AgentState`。

### 4.2 捕获：`captureState(state)`

从当前 `AgentState` 生成待保存快照：基于现有 `memory`、嵌入 `sessionMemoryRecordFromState`、收集 `preservedContextAssets`（按优先级与时间排序）。

### 4.3 落盘：`persistState` / `persistStateWithScopes`

- `persistState`：`applyMemoryPolicy(captureState)` → `store.save`
- `persistStateWithScopes`：通过 `MemoryWritePipeline.plan` 得到 `runSnapshot` 与各 `scopedSnapshots`；先保存 run 级快照，再对每个有 namespace 的作用域 **merge 已有 scoped 快照** 后策略化与租户策略化再保存

适用于「一次运行 ID + 多租户/多项目桶」的部署形态。

### 4.4 自动保存：`maybeAutoSave(runId, state, scopeContext?, options?)`

前提：`subsystem` 含 `scopeStore`、`extractor` 且传入 `scopeContext`。否则直接返回原 `state`。

- **查询来源过滤**：仅当 `querySource` 为 `undefined`、`"sdk"` 或以 `repl_main_thread` 开头时执行；否则发 `memory_auto_save_skipped`（`non_main_thread`）。
- ** eligibility**：`shouldAutoSaveMemory`（默认至少 6 条消息、且最新消息 id 未在 `automation.lastAutoSavedMessageId` 上处理过）。
- 使用 `buildMemoryAutomationWindow` 截取最近若干条消息（默认最多 24 条）调用 `extractor.extract`。
- 合并提取的 `semantic.entries`，经 `applyMemoryPolicy`、`applyMemoryGovernance`、`applyMemoryTenantPolicy`，写回 `store` 并按条目 `scope`（缺省为 `automation.targetScope`，默认 `project`）写入各作用域桶。
- 全程通过 `hooks.onEvent` 上报 `memory_auto_save_*`、`memory_scope_persisted`、`memory_governed` 等事件。

**实现 `MemoryExtractor` 时**：输入为 `MemoryExtractionInput`（`runId`、`conversation`、`snapshot`、`scopeContext`、`namespaces`、`signal?`），返回 `{ entries: MemorySemanticEntry[] }`。

### 4.5 提示词：`buildPromptMemory(snapshot, recall?)`

按固定顺序拼接文本块：`activePlan` → `skills` → `rules` → **经 `recallMemoryEntries` 过滤后的语义记忆** → 其他顶层键。再用 `promptTokenBudget` 做简单 token 估算截断（约 `length/4`）。

`MemoryRecallInput`：

- `ignoreMemory: true` → 返回 `null`
- `query`：用于关键词重叠打分；`explicit: true` 时无查询则要求 `score > 0`，有查询则要求 `overlap > 0`
- 非 explicit 模式默认 `score >= 10` 才入选；若无入选则按类型优先级与时间回退最多 6 条（可用 `limit` 覆盖）

### 4.6 `loadSnapshot(runId)`

返回规范化的 `MemorySnapshot`（无 store 时为空快照）。

---

## 5. 策略与治理

### 5.1 `DEFAULT_MEMORY_POLICY`

默认：`maxRecentFiles` 8、`maxSkills`/`maxRules` 8、`maxSemanticEntries` 24、`maxArtifacts` 24、`maxContentChars` 4000。超长内容尾部截断为 `...`。

### 5.2 `DEFAULT_MEMORY_GOVERNANCE_CONFIG`

默认：语义条目保留 180 天内、`redactEmails` / `redactSecrets` 为 true。脱敏作用于 working 文本字段、语义条目与 artifact。

### 5.3 `MemoryTenantPolicy`

用于多租户隔离与合规：限制允许写入/读出的 `scope` 与 `type`、可选剥离正文、用租户级上限覆盖 `MemoryPolicy`、并可单独打开邮箱/密钥脱敏（通过再走一遍 `applyMemoryGovernance` 且关闭按天过期）。

---

## 6. `MemoryCommandService`（工具/CLI 场景）

依赖 `ScopedMemoryStore` + 可选 `policy`。

- `save({ scope, namespace, entry })`：校验 `type`（`parseMemoryTaxonomyType`），拒绝「可从仓库直接推导」类内容（启发式，见 `isDerivableSemanticMemory`），合并后 `applyMemoryPolicy` 再保存。
- `list` / `delete` / `recall`：对单桶操作。

---

## 7. 同步服务

### 7.1 `MemorySnapshotSyncService`（本地两目标）

- `checkForUpdate({ source, target })` → `none` | `initialize` | `prompt-update`（比较 `getMemorySnapshotUpdatedAt` 与 `MemorySyncState.syncedFrom`）
- `initializeFromSnapshot` / `replaceFromSnapshot`：把源快照复制到目标并写入 sync state
- `markSnapshotSynced`：仅更新 sync 元数据

配套：`InMemoryMemorySyncStateStore`、`FileMemorySyncStateStore`。

### 7.2 `MemoryTeamSyncService`（远程）

- **构造**：`(scopedStore, remoteTransport, { maxConflictRetries?, maxBatchBytes?, hooks? })`
- **pull**：`ifNoneMatch` 用本地 `MemoryTeamSyncState.lastKnownChecksum`；成功则写入 `scopedStore` 并更新 state
- **push**：先 `checkSharedMemorySnapshotForSecrets`，命中密钥规则的语义等条目会 **跳过上传** 并发 `memory_team_sync_secret_skipped`；其余按与服务器条目 checksum 差异分批 `push`；冲突时拉取 `pullHashes` 重试，默认最多 2 次重试

测试与本地模拟可用 `InMemoryMemoryRemoteTransport`。`decodeRemoteMemoryEntryKey` 用于解析条目 key 的最后一段。

---

## 8. 安全与运维

- **`scanMemorySecrets` / `checkSharedMemorySnapshotForSecrets`**：针对 GitHub PAT、OpenAI key、Slack bot token 等正则扫描；`doctor` 与团队推送共用。
- **`inspectMemoryHealth(snapshot, options?)`**：估算提示记忆 token、策略是否「吃紧」、密钥问题、团队同步是否过久未更新（默认 24h）。

---

## 9. 包导入方式

从 `@renx/agent` 包入口会再导出本模块主要符号；在包内相对路径为 `./memory` 或 `../memory`。

示例：

```ts
import {
  MemoryService,
  FileMemoryStore,
  FileScopedMemoryStore,
  createMemorySnapshot,
  mergeMemorySnapshot,
  type MemorySubsystem,
  type MemoryScopeContext,
} from "@renx/agent";
```

（具体导出列表以 `packages/agent/src/index.ts` 为准。）

---

## 10. 事件类型（`MemoryEvent`）

便于日志与可观测性：

- `memory_auto_save_started` | `completed` | `failed` | `skipped`
- `memory_scope_persisted`
- `memory_governed`
- `memory_team_sync_pull_completed` | `push_completed` | `conflict` | `secret_skipped`

---

## 11. 测试与延伸阅读

- 单元与 RED 测试：`packages/agent/test/memory/*.test.ts`
- 与记忆相关的上层设计文档（若存在）：仓库内 `docs/memory/`

---

## 12. 实现时注意点（简表）

1. **合并语义**：同路径 recent file、同 identity 的 skill/rule、同 `id` 的语义条目与 asset 会合并去重，排序规则见 `snapshot.ts`。
2. **无结构化层时**：`mergeMemorySnapshot` 对两个「非分层」对象做浅合并，用于兼容遗留形态。
3. **自动保存** 强依赖 `scopeContext` 与 `extractor`；仅主线程类 `querySource` 会执行，避免后台任务误写共享记忆。
4. **团队推送** 不会上传被密钥扫描判定的条目；需在 UI 或运维上提示用户清理。
5. **`MemoryCommandService.save`** 的「不可保存可推导信息」是保守启发式，误杀时可调整条目文案或扩展该逻辑（在本仓库内修改 `commands.ts`）。

如有与 `AgentRuntime`、`SessionMemoryService` 的联调细节，可对照 `packages/agent/src/runtime/agent-runtime.ts` 中 `MemoryService` 的调用点。
