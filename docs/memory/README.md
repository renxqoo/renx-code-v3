# Claude Code 记忆系统文档（6+1 分册）

分析对象源码树：**`D:\work\claude-code-source`**（与合订本扉页一致）。

完整合订本仍为同目录下的 **[`claude-code-memory-system-deep-analysis.md`](./claude-code-memory-system-deep-analysis.md)**（**未删除**；仅额外提供分册便于检索与并行阅读）。

---

## 分册一览

| 分册 | 文件 | 适合谁 | 内容概要 |
|------|------|--------|----------|
| 01 | [`01-overview.md`](./01-overview.md) | 新人、写汇报、架构扫盲 | 摘要～结语、执行摘要～「二十」：术语、六层模型、时序、结论 |
| 02 | [`02-subsystems-runtime.md`](./02-subsystems-runtime.md) | 开发跟代码 | 「二十一～三十」模块深拆 + 「三十七～四十五」逐函数与速览 |
| 03 | [`03-security-and-ops.md`](./03-security-and-ops.md) | 安全评审、SRE、上线 | 「五十」Gate 矩阵、API 契约、攻击树、Runbook、Telemetry |
| 04 | [`04-reference-prompts-and-contracts.md`](./04-reference-prompts-and-contracts.md) | Prompt / 协议对齐 | 「五十一」SessionMemory prompts、「五十二」系统提示词还原 |
| 05 | [`05-audit-and-testing.md`](./05-audit-and-testing.md) | 审计、QA | 「三十一～三十六」论证与测试策略、「四十六～四十八」伪代码与测试模板 |
| 06 | [`06-diagrams.md`](./06-diagrams.md) | 讲架构、评审演示 | 「三十四」时序/结构图、「四十九」流程图 + 逐步解读 |

---

## 推荐阅读路径

1. **30 分钟建立全局观**：`01-overview.md`（摘要 + 执行摘要 + 架构总览）。  
2. **按运行时读实现**：`02-subsystems-runtime.md` 从「二十一」paths → memdir → 召回 → extract → session → team。  
3. **上线前检查清单**：`03-security-and-ops.md` 的 Gate 矩阵 + Runbook。  
4. **对照模型实际说了什么**：`04-reference-prompts-and-contracts.md`。

---

## 源码核对快照（基于本地 `claude-code-source`）

以下条目用于与文档交叉验证；**若你本地仓库版本不同，以你磁盘上的实现为准**。

| 项 | 源码依据（摘录要点） |
|----|----------------------|
| 包标识 | `package.json`：`name` 为 `@anthropic-ai/claude-code`，撰写本文档时目录内 `version` 为 **2.1.88**（随上游变更会不同）。 |
| AutoMemory 总开关 | `src/memdir/paths.ts`：`isAutoMemoryEnabled()` 注释写明优先级链——`CLAUDE_CODE_DISABLE_AUTO_MEMORY` → `CLAUDE_CODE_SIMPLE` → 远程且无 `CLAUDE_CODE_REMOTE_MEMORY_DIR` → `settings.autoMemoryEnabled` → 默认启用。 |
| 记忆根目录 | 同文件 `getMemoryBaseDir()`：`CLAUDE_CODE_REMOTE_MEMORY_DIR` 优先，否则 `getClaudeConfigHomeDir()`（默认 `~/.claude` 体系）。 |
| 抽取子代理 Gate | 同文件 `isExtractModeActive()`：依赖 GrowthBook `tengu_passport_quail`；非交互会话还需 `tengu_slate_thimble`；注释说明调用方还须直接对 `feature('EXTRACT_MEMORIES')` 做 `if` 判断（不可仅依赖本 helper）。 |
| Memory 段挂载 | `src/constants/prompts.ts`：`import { loadMemoryPrompt } from '../memdir/memdir.js'`，并在系统提示词组装中调用 `loadMemoryPrompt()`。 |

---

## 维护说明（合订本更新后如何重拆）

分册由合订本按**行号区间**截取生成；更新合订本后若需同步分册，应对下列区间重新截取（行号为合订本内 `## ` 标题所在文件行号，**更新后可能漂移**，需以 `grep '^## '` 为准）：

| 目标文件 | 合订本行号区间（生成时的参考） |
|----------|-------------------------------|
| `01-overview.md` | 1–711，再接 712–1354 |
| `02-subsystems-runtime.md` | 1355–1933，再接 2208–2921 |
| `05-audit-and-testing.md` | 1934–2207，再接 2923–3397 |
| `06-diagrams.md` | 2054–2133，再接 3398–3971 |
| `03-security-and-ops.md` | 3972–4179 |
| `04-reference-prompts-and-contracts.md` | 4180–EOF |

各分册顶部的「分册说明」扉页在重拆后需手工保留或再次插入。

---

## `+1` 指什么

**+1 = 本 `README.md`**（索引与源码快照），不计入正文篇幅，但承担导航与核对职责。
