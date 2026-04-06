# 分册 04：提示词与契约参考

> **节选来源**：[claude-code-memory-system-deep-analysis.md](./claude-code-memory-system-deep-analysis.md)  
> **分析源码树**：`D:\work\claude-code-source`  
> **本册对应合订本章节**：五十一（SessionMemory prompts）、五十二（系统提示词按代码还原）。

### 源码锚点

- Session 笔记模板与更新提示词：`src/services/SessionMemory/prompts.ts`
- Extract 子代理：`src/services/extractMemories/prompts.ts`
- Memdir / KAIROS / Combined：`src/memdir/memdir.ts`、`src/memdir/teamMemPrompts.ts` 等
- 主系统提示词装配：`src/constants/prompts.ts`（`loadMemoryPrompt` 注入点）

---

## 五十一、`SessionMemory/prompts.ts` 专项补充（函数级深拆）

> 你点名要补这一文件，这里按“实现了什么 + 怎么实现 + 为什么这样实现 + 边界风险”做专项分析。  
> 文件路径：`src/services/SessionMemory/prompts.ts`

### 51.1 文件定位：它不是业务逻辑，而是“提示词协议层”

`sessionMemory.ts` 负责“何时触发更新”，而 `prompts.ts` 负责“更新时让模型按什么协议写”。  
该文件的本质职责：

1. 提供默认 session note 模板；
2. 提供默认更新提示词与可覆盖机制（本地配置文件）；
3. 在生成更新提示词前，动态追加“超长 section / 总预算超限”的压缩提醒；
4. 在 compact 注入阶段，提供 section 级截断函数，防止 session memory 反向撑爆上下文。

---

### 51.2 常量设计

- `MAX_SECTION_LENGTH = 2000`
- `MAX_TOTAL_SESSION_MEMORY_TOKENS = 12000`

这两个阈值构成“双层预算”：

- section 层预算：避免某一节（如 Worklog）无限膨胀；
- 整体预算：保证 session memory 注入 compact 后仍留足空间给其他消息。

注意：实现里 token 是估算值（`roughTokenCountEstimation`），不是模型精确计费 token。  
这是性能/准确性的工程折中。

---

### 51.3 `DEFAULT_SESSION_MEMORY_TEMPLATE`

**实现了什么**  
定义 session note 的规范结构（10 个 section），作为首次创建文件时的初始内容，也作为“是否空模板”的对比基准。

**怎么实现**

- 多行模板字符串，section 标题 + 斜体说明行；
- 标题是结构锚点（`# ` 开头），斜体说明行是语义约束；
- 后续编辑提示词明确禁止改动这两类结构内容。

**为什么这样实现**

- 统一结构让后续自动提取、压缩、人工阅读都可预期；
- 避免模型每轮重塑文档结构导致“可追踪性崩溃”。

**边界/风险**

- 若用户自定义模板改动结构，部分依赖“`# ` 标题切分”的函数仍可工作，但语义可能漂移。

---

### 51.4 `getDefaultUpdatePrompt()`

**实现了什么**  
生成默认“更新 session notes”的系统任务提示词，强约束模型只做 Edit，不做其他工具调用。

**怎么实现**

- 用长文本协议明确：
  - “本提示不是用户对话内容”；
  - 仅允许 Edit 工具；
  - section/header/italic 行不可改；
  - 内容必须信息密集；
  - `Current State` 必须持续更新；
  - 支持多次并行 Edit 后立即停止；
  - 变量占位符 `{{notesPath}}`、`{{currentNotes}}` 待后续替换。

**为什么这样实现**

- 这是对模型“自由发挥”的强约束，目标是把更新行为从生成任务变成“结构化编辑任务”。

**边界/风险**

- 文本协议很长，若未来改动提示词需回归“是否仍严格禁止结构改写”。

---

### 51.5 `loadSessionMemoryTemplate()`

**实现了什么**  
支持用户本地覆盖默认模板（`~/.claude/session-memory/config/template.md`）。

**怎么实现**

1. 拼接模板路径；
2. `readFile` 尝试读取；
3. `ENOENT` -> 返回默认模板；
4. 其他错误 -> `logError` 并回退默认模板。

**为什么这样实现**

- 允许高级用户自定义结构；
- 失败时永不阻塞主流程（回退默认）。

**边界/风险**

- 自定义模板质量无自动校验，可能导致后续 section 分析逻辑适配变差。

---

### 51.6 `loadSessionMemoryPrompt()`

**实现了什么**  
支持用户本地覆盖默认更新提示词（`~/.claude/session-memory/config/prompt.md`）。

**怎么实现**

- 逻辑与 `loadSessionMemoryTemplate` 同构：
  - 成功读文件则使用；
  - `ENOENT` 或异常则回退 `getDefaultUpdatePrompt()`。

**为什么这样实现**

- 给 power-user 改 prompt 策略的能力，同时保留安全回退。

**边界/风险**

- 自定义 prompt 可能破坏“只 edit 单文件”纪律，建议在文档中提醒风险。

---

### 51.7 `analyzeSectionSizes(content)`

**实现了什么**  
按 section 粒度统计当前 notes 各 section token 估算值。

**怎么实现**

1. 按行遍历；
2. 遇到 `# ` 视为新 section；
3. 对上一 section 的 content 用 `roughTokenCountEstimation` 估算；
4. 返回 `Record<sectionHeader, tokenEstimate>`。

**为什么这样实现**

- 不依赖 markdown AST，成本低；
- 与模板的标题结构强耦合，足够稳定。

**边界/风险**

- 若模板标题不以 `# ` 开头，会影响切分；
- 估算 token 非精确，适合提醒，不适合计费级控制。

---

### 51.8 `generateSectionReminders(sectionSizes, totalTokens)`

**实现了什么**  
在生成更新 prompt 时追加“压缩提醒块”，引导模型主动瘦身超长 section。

**怎么实现**

1. 判定整体是否超 `MAX_TOTAL_SESSION_MEMORY_TOKENS`；
2. 收集并排序超 `MAX_SECTION_LENGTH` 的 section；
3. 无超限则返回空字符串；
4. 若整体超限，追加 CRITICAL 提醒；
5. 若有超长 section，追加逐项列表提醒。

**为什么这样实现**

- 不是在写后再被动截断，而是“写前提醒模型压缩”，减少后续截断信息损失。

**边界/风险**

- 提醒是软约束，最终还需 `truncateSessionMemoryForCompact` 做硬兜底。

---

### 51.9 `substituteVariables(template, variables)`

**实现了什么**  
将 `{{var}}` 占位符替换为实际内容。

**怎么实现**

- 使用单次 regex replace：`/\{\{(\w+)\}\}/g`；
- 回调中检查 key 是否存在于 `variables`；
- 不存在则保留原占位符。

**为什么“单次替换”是关键**

代码注释明确提到避免两个问题：

1. `$` 反向引用污染（字符串替换语义坑）；
2. 双重替换（用户内容里恰好包含 `{{var}}` 被二次替换）。

这属于“模板引擎最小实现”的正确做法。

---

### 51.10 `isSessionMemoryEmpty(content)`

**实现了什么**  
判断当前 session memory 是否还只是模板（尚无真实沉淀内容）。

**怎么实现**

1. 读取当前模板（可被用户覆盖）；
2. `trim()` 后字符串全等比较。

**为什么这样实现**

- compact 决策要区分“有文件但没信息”与“有真实摘要”。

**边界/风险**

- 若用户模板含动态内容或空白差异，`trim` 已处理基本空白，但语义等价不一定可捕获。

---

### 51.11 `buildSessionMemoryUpdatePrompt(currentNotes, notesPath)`

**实现了什么**  
组合最终给子代理的更新提示词（模板 + 变量替换 + 超限提醒）。

**怎么实现**

1. 加载 prompt 模板（默认或用户覆盖）；
2. `analyzeSectionSizes(currentNotes)`；
3. 估算整体 token；
4. 生成 `sectionReminders`；
5. 用 `substituteVariables` 注入 `currentNotes/notesPath`；
6. 返回 `basePrompt + sectionReminders`。

**为什么这样实现**

- 将“静态协议文本”与“动态状态提醒”分离，便于后续演进。

**副作用**

- 无外部副作用（纯字符串构建，仅读本地配置文件）。

---

### 51.12 `truncateSessionMemoryForCompact(content)`

**实现了什么**  
compact 场景下对 session memory 做 section 级硬截断，防止 summary 占满 token 预算。

**怎么实现**

1. 按行遍历 section；
2. 每个 section 调 `flushSessionSection`；
3. 聚合输出，记录是否发生截断；
4. 返回 `{truncatedContent, wasTruncated}`。

**关键策略**

- 不是按全文件硬截断，而是按 section 独立截断；
- 保留 section 标题，尽量保留结构可读性。

---

### 51.13 `flushSessionSection(sectionHeader, sectionLines, maxCharsPerSection)`

**实现了什么**  
执行单个 section 的截断动作。

**怎么实现**

1. 无 header（文件前导区）直接原样返回；
2. section 长度未超限，原样返回；
3. 超限时按行累积直到接近阈值；
4. 追加 `"[... section truncated for length ...]"` 标记。

**为什么是按字符近似 token**

- `roughTokenCountEstimation` 的近似关系是 `chars/4`，这里直接用 `MAX_SECTION_LENGTH * 4` 转字符阈值，避免重复 token 估算开销。

**边界/风险**

- 字符阈值近似对不同语言 token 密度有偏差；
- 但 compact 场景目的是“强制瘦身”，近似可接受。

---

### 51.14 `SessionMemory/prompts.ts` 与其他模块的调用关系

#### 调用方

- `sessionMemory.ts`
  - `loadSessionMemoryTemplate`（初始化文件）
  - `buildSessionMemoryUpdatePrompt`（更新任务）
- `sessionMemoryCompact.ts`
  - `isSessionMemoryEmpty`（是否可用于 compact）
  - `truncateSessionMemoryForCompact`（压缩前硬截断）

#### 被依赖语义

1. 模板结构稳定性（标题 + 说明行）；
2. 预算提醒与硬截断协同；
3. 空模板判定准确性。

---

### 51.15 建议补充到测试的专项用例（针对该文件）

1. **变量替换安全**
   - `currentNotes` 包含 `{{notesPath}}` 字样时，不应二次替换污染。
2. **section 分析正确性**
   - 多 section + 空 section + 尾 section 都应统计。
3. **超限提醒拼接**
   - only total overBudget / only oversizedSections / both / none 四象限。
4. **compact 截断稳定性**
   - 超长 section 保留 header 且带截断标记；
   - 未超长 section 完整保留。
5. **空模板判定**
   - 默认模板、用户模板、trim 空白差异都覆盖。


---

## 五十二、系统提示词详解（按代码还原）

> 本章把记忆系统相关的“系统提示词”按源码实现还原为可读模板。  
> 重点覆盖：主系统提示词的 memory 段、TEAMMEM 组合段、KAIROS 日志段、后台子代理提示词。  
> 说明：以下内容是依据实现逻辑整理的结构化还原，实际文本会随 gate、env、settings 和运行模式动态变化。

### 52.1 主系统提示词（Auto-only Memory）

**代码来源**
- `src/memdir/memdir.ts`：`buildMemoryLines()`, `loadMemoryPrompt()`
- `src/memdir/memoryTypes.ts`：类型学与规则段

**模板还原**

```text
# auto memory

You have a persistent, file-based memory system at `<AUTO_MEM_DIR>/`.
This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).

You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.

If the user explicitly asks you to remember something, save it immediately as whichever type fits best.
If they ask you to forget something, find and remove the relevant entry.

## Types of memory
<types>
  <type><name>user</name> ... </type>
  <type><name>feedback</name> ... </type>
  <type><name>project</name> ... </type>
  <type><name>reference</name> ... </type>
</types>

## What NOT to save in memory
- Code patterns, conventions, architecture, file paths, or project structure
- Git history / who changed what
- Debug recipes already represented in code
- Anything already in CLAUDE.md
- Ephemeral task details
- Even when user asks to save PR/activity list, ask for surprising/non-obvious part

## How to save memories
Step 1: Write memory into topic file with frontmatter:
---
name: ...
description: ...
type: user|feedback|project|reference
---
<content>

Step 2: Add one-line pointer into MEMORY.md index:
- [Title](file.md) — one-line hook

Rules:
- MEMORY.md is always loaded; beyond line cap gets truncated
- Keep name/description/type fresh
- Organize by semantic topic, not chronology
- Update/remove outdated memory
- Avoid duplicates

## When to access memories
- When relevant or user references past work
- MUST access when user asks to check/recall/remember
- If user says ignore memory: act as if MEMORY.md empty
- Memory can be stale; verify against current files/resources before acting

## Before recommending from memory
- File path claims: verify file exists
- Function/flag claims: grep first
- If user will act on recommendation: verify first
- “memory says X existed” != “X exists now”
- Snapshot memories are historical; for current/recent state prefer code/git

## Memory and other forms of persistence
- Plan is for approach alignment
- Tasks are for current conversation execution tracking
- Memory is for future conversation reuse
```

**实现要点**
- `loadMemoryPrompt()` 会根据 gate 决定是否注入该段；
- `MEMORY.md` 内容受 `truncateEntrypointContent()` 约束（行/字节双上限）；
- `buildSearchingPastContextSection()` 在指定 gate 下追加搜索建议。

---

### 52.2 主系统提示词（Auto + Team Combined）

**代码来源**
- `src/memdir/teamMemPrompts.ts`：`buildCombinedMemoryPrompt()`
- `src/memdir/memoryTypes.ts`：`TYPES_SECTION_COMBINED`

**模板还原**

```text
# Memory

You have a persistent, file-based memory system with two directories:
- private directory: `<AUTO_MEM_DIR>/`
- shared team directory: `<AUTO_MEM_DIR>/team/`
Both directories already exist — write to them directly with the Write tool.

## Memory scope
- private: private between assistant and current user
- team: shared across organization contributors in this project

## Types of memory
(same 4 types with scope guidance per type)
- user: always private
- feedback: default private, team only for project-wide conventions
- project: private or team, usually team-biased
- reference: usually team

## What NOT to save
(same exclusions as auto-only)
+ extra rule: never store sensitive secrets in team memory

## How to save
Step 1: write topic file in chosen scope directory
Step 2: add pointer into that directory's MEMORY.md
(private/team each own separate MEMORY.md)
```

**实现要点**
- team memory 作为 auto memory 子目录；
- `isTeamMemoryEnabled()` 受 auto-memory 总开关约束；
- combined 模式下类型学文本会包含 scope 指导，降低模型写错目录概率。

---

### 52.3 KAIROS 模式系统提示词（Daily Log 范式）

**代码来源**
- `src/memdir/memdir.ts`：`buildAssistantDailyLogPrompt()`

**模板还原**

```text
# auto memory

You have a persistent, file-based memory system at `<AUTO_MEM_DIR>/`.

This session is long-lived.
Record anything worth remembering by appending to today's daily log file:
`<AUTO_MEM_DIR>/logs/YYYY/MM/YYYY-MM-DD.md`

Substitute current date from context.
On date rollover, switch to the new file.

Write timestamped bullets.
Create file/parent dirs on first write.
Do not rewrite/reorganize log (append-only).

A nightly process distills logs into MEMORY.md and topic files.
Read MEMORY.md for orientation; do not maintain it directly in this mode.
```

**实现要点**
- 提示词中使用“路径模式”而非当天具体路径，降低 prompt cache 失效；
- 新信息先入日志，蒸馏任务后处理，减少长期会话下索引抖动。

---

### 52.4 ExtractMemories 子代理提示词（回合后抽取）

**代码来源**
- `src/services/extractMemories/prompts.ts`

**模板还原**

```text
You are now acting as the memory extraction subagent.
Analyze the most recent ~N messages and update persistent memory.

Available tools:
- FileRead, Grep, Glob
- read-only Bash
- FileEdit/FileWrite only within memory directory
- all other tools denied

You have limited turns.
Recommended strategy:
- turn 1: parallel reads
- turn 2: parallel writes/edits

MUST only use information from the recent messages.
Do not investigate code/git outside this context.

(optional) Existing memory manifest included:
- update existing memories instead of creating duplicates

Then includes:
- type taxonomy (individual/combined)
- what NOT to save
- how to save (skipIndex gate-dependent)
```

**实现要点**
- 提示词和 `createAutoMemCanUseTool()` 配套形成“软硬双约束”；
- main agent 已写 memory 时，该提示词对应流程会被跳过（互斥机制）。

---

### 52.5 SessionMemory 更新提示词（会话笔记编辑协议）

**代码来源**
- `src/services/SessionMemory/prompts.ts`：`getDefaultUpdatePrompt()`, `buildSessionMemoryUpdatePrompt()`

**模板还原**

```text
IMPORTANT: These note-taking instructions are not part of user conversation.
Do not mention note-taking/session extraction in notes.

File {{notesPath}} has been read:
<current_notes_content>
{{currentNotes}}
</current_notes_content>

ONLY use Edit tool on {{notesPath}}, then stop.
No other tools.

CRITICAL RULES:
- preserve all section headers and italic section-description lines
- only edit content below descriptions
- no new sections
- no filler
- include concrete technical details
- keep "Current State" updated
- keep section length under budget

(build-time appends dynamic reminders:)
- total token budget exceeded warning
- oversized sections list
```

**实现要点**
- 变量替换由 `substituteVariables()` 单次替换完成，避免二次替换污染；
- 预算提醒由 `generateSectionReminders()` 动态拼接；
- compact 侧仍有 `truncateSessionMemoryForCompact()` 硬兜底。

---

### 52.6 主系统提示词中的挂载位置

**代码来源**
- `src/constants/prompts.ts`：通过 `loadMemoryPrompt()` 把 memory 段接入系统提示词组装流程。

**结论**
- memory 不是独立请求参数，而是主系统提示词的一部分 section；
- 具体注入文本由当前 gate/env/settings/模式动态决定。

---

### 52.7 占位符参数说明（文档化建议）

| 占位符 | 来源 | 用途 |
|---|---|---|
| `<AUTO_MEM_DIR>` | `getAutoMemPath()` | 自动记忆根目录 |
| `<AUTO_MEM_DIR>/team/` | `getTeamMemPath()` | 团队共享目录 |
| `{{notesPath}}` | `buildSessionMemoryUpdatePrompt()` 参数 | 会话笔记文件路径 |
| `{{currentNotes}}` | `buildSessionMemoryUpdatePrompt()` 参数 | 当前会话笔记内容 |
| `~N messages` | extract 运行时统计 | 限定抽取语义窗口 |

---

