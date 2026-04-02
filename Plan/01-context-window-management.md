# 01 - 上下文窗口管理总设计

## 1. 结论

`renx-code-v3\Plan\01-context-window-management.md` 之前并不完善，且不足以指导后续实现。它的问题不只是“缺少几个功能点”，而是整体设计粒度、运行时接入点、状态持久化要求、压缩恢复链路、模型契约扩展都没有覆盖到位。

本次文档重构的目标不是写一个“上下文超限时做摘要”的简单方案，而是形成一套可直接指导实现的技术说明文档，要求覆盖 `claude-code-source` 中与上下文管理相关的核心能力，并且与 `renx-code-v3` 当前实际代码结构对齐。

## 2. 目标

本设计集需要完整定义以下内容：

- 如何在 `renx-code-v3` 中区分 `canonical history` 与 `API view`。
- 如何建立与 Claude Code 对齐的多层压缩管线，而不是单一摘要策略。
- 如何实现“真实 usage + 增量估算”的混合 token 计数。
- 如何定义 warning、auto-compact、error、blocking 多级阈值。
- 如何保证 assistant/tool_use/tool_result/thinking 片段的原子完整性。
- 如何定义 `compact_boundary`、`preservedSegment`、归档消息、恢复锚点。
- 如何实现 session memory compact、context collapse、auto compact、reactive compact。
- 如何在压缩后恢复最近文件、计划、技能、hooks、MCP 指令等工作上下文。
- 如何处理压缩请求本身也超长的 Prompt-Too-Long 重试。
- 如何复用 forked agent cache prefix，降低压缩成本与延迟。
- 如何扩展 `packages/agent`、`packages/model` 的运行时契约、状态结构与测试体系。

## 3. 参考来源

本设计依据以下 Claude Code 源码与文档整理，不是凭空推断：

- `claude-code-source\docs\query-loop-overview.md`
- `claude-code-source\docs\steps\step-01-02-context-budget.md`
- `claude-code-source\docs\steps\step-03-05-compression-pipeline.md`
- `claude-code-source\docs\steps\step-06-autocompact.md`
- `claude-code-source\docs\steps\step-10-error-recovery.md`
- `claude-code-source\docs\steps\step-11-12-hooks-budget.md`
- `claude-code-source\src\query.ts`
- `claude-code-source\src\services\compact\autoCompact.ts`
- `claude-code-source\src\services\compact\compact.ts`
- `claude-code-source\src\services\compact\microCompact.ts`
- `claude-code-source\src\services\compact\grouping.ts`
- `claude-code-source\src\services\compact\prompt.ts`
- `claude-code-source\src\services\compact\sessionMemoryCompact.ts`
- `claude-code-source\src\services\compact\postCompactCleanup.ts`
- `claude-code-source\src\utils\tokens.ts`
- `claude-code-source\src\utils\messages.ts`
- `claude-code-source\src\utils\toolResultStorage.ts`
- `claude-code-source\src\utils\forkedAgent.ts`
- `claude-code-source\src\types\logs.ts`

其中，少量内部实现细节在本地源码中并未以完整独立模块呈现，例如 `ContextCollapse` 的内部算法细节。这类部分本文档会明确标注“行为契约必须对齐，内部实现允许等价替代”，避免把不可见细节误写成伪精确实现。

## 4. 与当前仓库的对齐范围

本设计必须落在 `renx-code-v3` 当前真实代码结构上，而不是假定一个不存在的 `src/` 扁平工程。当前需要接入的主要模块是：

- `renx-code-v3\packages\agent\src\runtime.ts`
- `renx-code-v3\packages\agent\src\base.ts`
- `renx-code-v3\packages\agent\src\types.ts`
- `renx-code-v3\packages\agent\src\message\manager.ts`
- `renx-code-v3\packages\agent\src\message\types.ts`
- `renx-code-v3\packages\model\src\types.ts`
- `renx-code-v3\packages\model\src\errors.ts`

现状判断如下：

| 模块 | 当前状态 | 与目标差距 |
| --- | --- | --- |
| `packages/agent/src/runtime.ts` | 有 `run()` 和 `stream()` 主循环，但没有上下文预算与压缩管线 | 需要成为上下文管理的主要接入点 |
| `packages/agent/src/message/manager.ts` | 仅做固定历史窗口裁剪 | 无法表达 canonical history / API view 分离 |
| `packages/agent/src/message/types.ts` | 消息结构偏轻量 | 缺少压缩边界、usage、轮次、恢复锚点元数据 |
| `packages/model/src/types.ts` | 缺少 provider response id、usage 细节、iteration 级上下文统计 | 无法支撑混合 token 计数与 API 视图回溯 |
| `packages/model/src/errors.ts` | 已有 `CONTEXT_OVERFLOW` 类错误基础 | 可复用到 reactive compact 流程 |

## 5. 交付物

本次不再把所有内容塞进一个文档，而是拆成一个总索引和六个详细子文档：

- `renx-code-v3\Plan\01-context-window-management.md`
- `renx-code-v3\Plan\context-window-management\01-source-parity-and-target-architecture.md`
- `renx-code-v3\Plan\context-window-management\02-token-accounting-thresholds-and-api-view.md`
- `renx-code-v3\Plan\context-window-management\03-message-model-boundaries-and-persistence.md`
- `renx-code-v3\Plan\context-window-management\04-compaction-pipeline-and-strategy-details.md`
- `renx-code-v3\Plan\context-window-management\05-recovery-rehydration-and-forked-agent-cache.md`
- `renx-code-v3\Plan\context-window-management\06-runtime-integration-model-contracts-and-test-plan.md`
- `renx-code-v3\Plan\context-window-management\07-source-function-parity-matrix.md`
- `renx-code-v3\Plan\context-window-management\08-default-config-sequences-and-acceptance-appendix.md`
- `renx-code-v3\Plan\context-window-management\09-end-to-end-flowchart-and-decision-tree.md`

## 6. 完整能力清单

下表定义本设计集必须覆盖的全部能力。只有全部写清楚，后续实现才不会偏离需求。

| 能力 | 是否必须 | 说明 | 对应文档 |
| --- | --- | --- | --- |
| Canonical history / API view 分离 | 必须 | 运行时保留完整主线，请求前投影压缩视图 | 01, 02, 03 |
| 混合 token 计数 | 必须 | 最近一次真实 usage + 之后新增消息估算 | 02 |
| 多级阈值 | 必须 | warning、auto compact、error、blocking | 02 |
| Tool result budget | 必须 | 工具结果预算与缓存引用替换 | 04 |
| History snip | 必须 | 轻量前置裁剪 | 04 |
| Microcompact | 必须 | 清理旧工具结果、缓存化、时间驱动折叠 | 04 |
| Context collapse | 必须 | 可逆的细粒度折叠视图 | 04 |
| Auto compact | 必须 | 语义摘要兜底压缩 | 04 |
| Session memory compact | 必须 | 直接复用会话记忆，无需 LLM 摘要 | 04 |
| Compact boundary | 必须 | 压缩后的边界标识与链式追踪 | 03 |
| API round grouping | 必须 | PTL 重试与安全截断的分组基础 | 03 |
| Tool/use/result/thinking 原子性 | 必须 | 任何裁剪都不能破坏协议完整性 | 03 |
| Media stripping | 必须 | 图片/文档内容在压缩前文本化替换 | 04, 05 |
| 结构化摘要 prompt | 必须 | 9 段式结构输出，禁止工具调用 | 04 |
| 压缩请求 PTL 重试 | 必须 | 压缩自己也超长时的递归恢复 | 05 |
| Reactive compact | 必须 | prompt-too-long / media-too-large 后恢复重试 | 05 |
| Post-compact rehydration | 必须 | 恢复文件、plan、skills、hooks、MCP | 05 |
| Post-compact cleanup | 必须 | 清缓存、重置微压缩、重置 collapse 状态 | 05 |
| Auto-compact 熔断 | 必须 | 连续失败上限，防死循环 | 05 |
| Forked agent cache reuse | 必须 | 共享 cached prefix，降低摘要成本 | 05 |
| Runtime 主循环接入 | 必须 | `run()` / `stream()` 一致行为 | 06 |
| Model 契约扩展 | 必须 | usage、response id、iteration stats | 06 |
| 状态持久化与 resume | 必须 | checkpoint 后可恢复 compact 历史 | 03, 06 |
| Claude Code 源码函数映射 | 必须 | 关键函数到 renx 实现文件的一一映射 | 07 |
| 默认参数与时序附录 | 必须 | 默认值、状态机、时序图、验收矩阵 | 08 |
| 端到端整流程图 | 必须 | 全部判断节点、主分支、恢复分支、回写分支 | 09 |
| 测试与验收标准 | 必须 | 单测、集成测试、回归基线 | 06 |

## 7. 五层压缩机制口径（与 Claude Code 对齐）

为避免实现期把“压缩层数”和“执行步骤”混为一谈，本设计统一采用以下口径：

- **Layer 0（前置门禁，不计入五层）**：`Tool Result Budget`  
  目标是先抑制大体量工具结果污染，优先做 `_cacheRef` 替换或预算截断。
- **Layer 1**：`History Snip`  
  按 API round 轻量裁剪最老历史，优先保留最近工作尾部。
- **Layer 2**：`Microcompact`  
  对冷工具结果与缓存内容做持续微压缩，强调“每轮可执行”而非“超限后才执行”。
- **Layer 3**：`Context Collapse`  
  对中段历史做可逆折叠投影，保持可恢复性和细粒度追踪。
- **Layer 4**：`Session Memory Compact`  
  命中条件时直接复用 session memory，绕过额外摘要调用。
- **Layer 5（兜底）**：`Auto Compact`  
  在前四层仍不足时执行结构化语义摘要。

实现与测试时统一按以下顺序理解：

1. 先执行 Layer 0 预算门禁（不算压缩层）。
2. 再依次尝试五层压缩（Layer 1 到 Layer 5）。
3. 五层中只有 Layer 4/5 属于“总结型压缩”，其余均为轻量或可逆层。

## 8. 核心结论

Claude Code 的上下文管理不是一个“超阈值就做摘要”的单点机制，而是一个贯穿 query loop 的上下文预算与恢复系统。它有四个本质特征：

1. 它管理的是“视图”，不是简单“删消息”。
2. 它是分层渐进式压缩，而不是一步到位重摘要。
3. 它把压缩和恢复看成同一系统的两面，而不是只关注 token 下降。
4. 它依赖 message 边界、usage、round grouping、cache prefix、resume state 等多层契约协同工作。

因此，`renx-code-v3` 的实现也必须按系统工程来做，不能只在 `messageManager` 上补一个截断函数。

## 9. 推荐阅读顺序

建议后续实现者按以下顺序阅读这套文档：

1. 先读 `01-source-parity-and-target-architecture.md`，理解系统全貌。
2. 再读 `02-token-accounting-thresholds-and-api-view.md`，确定预算模型和阈值口径。
3. 然后读 `03-message-model-boundaries-and-persistence.md`，确定消息结构与持久化契约。
4. 再读 `04-compaction-pipeline-and-strategy-details.md`，实现多层压缩管线。
5. 接着读 `05-recovery-rehydration-and-forked-agent-cache.md`，实现恢复链路。
6. 最后按 `06-runtime-integration-model-contracts-and-test-plan.md` 完成代码接入与测试。
7. 实现前再读 `07-source-function-parity-matrix.md`，把 Claude Code 关键函数逐项映射到 renx 模块。
8. 进入编码和联调前，再读 `08-default-config-sequences-and-acceptance-appendix.md`，统一默认参数、时序和验收口径。
9. 开始实际编码、联调、排错时，配合 `09-end-to-end-flowchart-and-decision-tree.md` 逐节点对照执行路径。

## 10. 实施原则

为了避免实现偏离需求，后续编码必须遵守以下原则：

- 不允许只实现 AutoCompact 而跳过前面的轻量层。
- 不允许只做估算 token 计数而完全忽略模型返回 usage。
- 不允许在裁剪时破坏 tool call / tool result / assistant thinking 的完整配对。
- 不允许把压缩结果只表示成一个 summary 字符串，必须保留边界与恢复锚点。
- 不允许只在 `run()` 接入，`stream()` 必须同步具备同等上下文管理行为。
- 不允许压缩后直接继续运行而不做 rehydration 和 cleanup。
- 不允许把 Claude Code 中已明确存在的功能降级成“以后再说”，除非本文档明确标为内部算法可替代而非外部行为可省略。

## 11. 文档验收标准

这套文档写完后，应能满足以下验收要求：

- 实现者不需要再回到 Claude Code 源码里才能理解整体机制。
- 每个功能点都有明确的职责、输入、输出、状态变化和失败处理。
- 能直接映射到 `renx-code-v3` 现有模块的改造点。
- 能区分“必须与 Claude Code 行为对齐”的部分与“内部实现允许等价替代”的部分。
- 能据此编写测试，而不是只靠主观理解实现。

后续六个子文档即为具体实现说明。

## 12. 当前完整性结论

截至本次更新，这套文档不再只是“设计方向正确”，而是已经补到可直接指导完整实现的程度。若后续还需补充，应只属于实现阶段发现的仓库特定细节，而不是上下文管理方案本身的结构性缺失。
